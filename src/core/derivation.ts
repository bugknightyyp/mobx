import {IObservable, IDepTreeNode, addObserver, removeObserver} from "./observable";
import {globalState} from "./globalstate";
import {invariant} from "../utils/utils";
import {isComputedValue} from "./computedvalue";

export enum IDerivationState {
	// before being run or (outside batch and not being observed)
	// at this point derivation is not holding any data about dependency tree
	NOT_TRACKING = -1,
	// no shallow dependency changed since last computation
	// won't recalculate derivation
	// this is what makes mobx fast
	UP_TO_DATE = 0,
	// some deep dependency changed, but don't know if shallow dependency changed
	// will require to check first if UP_TO_DATE or POSSIBLY_STALE
	// currently only ComputedValue will propagate POSSIBLY_STALE
	//
	// having this state is second big optimization:
	// don't have to recompute on every dependency change, but only when it's needed
	POSSIBLY_STALE = 1,
	// shallow dependency changed
	// will need to recompute when it's needed
	STALE = 2
}

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode {
	observing: IObservable[];
	newObserving: null | IObservable[];
	dependenciesState: IDerivationState;
	/**
	 * Id of the current run of a derivation. Each time the derivation is tracked
	 * this number is increased by one. This number is globally unique
	 */
	runId: number;
	/**
	 * amount of dependencies used by the derivation in this run, which has not been bound yet.
	 */
	unboundDepsCount: number;
	__mapid: string;
	onBecomeStale();
}

export class CaughtException {
	constructor(public cause: any) {
		// Empty
	}
}

export function isCaughtException(e): e is CaughtException {
	return e instanceof CaughtException;
}

/**
 * Finds out wether any dependency of derivation actually changed
 * If dependenciesState is 1 it will recalculate dependencies,
 * if any dependency changed it will propagate it by changing dependenciesState to 2.
 *
 * By iterating over dependencies in the same order they were reported and stoping on first change
 * all recalculations are called only for ComputedValues that will be tracked anyway by derivation.
 * That is because we assume that if first x dependencies of derivation doesn't change
 * than derivation shuold run the same way up until accessing x-th dependency.
 */
export function shouldCompute(derivation: IDerivation): boolean {// 只在 reaction.runReaction() 和 computedValue.get() 里使用
	switch (derivation.dependenciesState) {
		case IDerivationState.UP_TO_DATE: return false;
		case IDerivationState.NOT_TRACKING: case IDerivationState.STALE: return true;
		case IDerivationState.POSSIBLY_STALE: {// 说明 derivation 依赖的 observable中含有 computedValue
			const prevUntracked = untrackedStart(); // no need for those computeds to be reported, they will be picked up in trackDerivedFunction.
			const obs = derivation.observing, l = obs.length;
			for (let i = 0; i < l; i++) {
				const obj = obs[i];
				if (isComputedValue(obj)) {// 如果依赖的 observable 是 computedValue
					try {
						obj.get();// 重新计算其值
					} catch (e) {
						// we are not interested in the value *or* exception at this moment, but if there is one, notify all
						untrackedEnd(prevUntracked);
						return true;
					}
					// if ComputedValue `obj` actually changed it will be computed and propagated to its observers.
					// and `derivation` is an observer of `obj`
					if ((derivation as any).dependenciesState === IDerivationState.STALE) {
						untrackedEnd(prevUntracked);
						return true;
					}
				}
			}
			changeDependenciesStateTo0(derivation);
			untrackedEnd(prevUntracked);
			return false;
		}
	}
}

export function isComputingDerivation() {
	return globalState.trackingDerivation !== null; // filter out actions inside computations
}

export function checkIfStateModificationsAreAllowed() {
	if (!globalState.allowStateChanges) {//这个全局状态只有在这里用了，控制能否修改 observable 的数据
		invariant(false, globalState.strictMode
			? "It is not allowed to create or change state outside an `action` when MobX is in strict mode. Wrap the current method in `action` if this state change is intended"
			: "It is not allowed to change the state when a computed value or transformer is being evaluated. Use 'autorun' to create reactive functions with side-effects."
		);
	}
}

/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
 /*
	 执行提供的方法 f, 跟踪访问了那些 observable， 所有的跟踪信息保存在 derivation 对象里， derivative也会注册到 所访问的 observable 里
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context) {
	// pre allocate array allocation + room for variation in deps
	// array will be trimmed by bindDependencies
	changeDependenciesStateTo0(derivation);
	derivation.newObserving = new Array(derivation.observing.length + 100);
	derivation.unboundDepsCount = 0;
	derivation.runId = ++globalState.runId;
	const prevTracking = globalState.trackingDerivation;
	globalState.trackingDerivation = derivation;
	let result;
	try {
		result = f.call(context);
	} catch (e) {
		result = new CaughtException(e);
	}
	globalState.trackingDerivation = prevTracking;
	bindDependencies(derivation);
	return result;
}

/**
 * diffs newObserving with obsering.
 * update observing to be newObserving with unique observables
 * notify observers that become observed/unobserved
 */
 /*
	负责将 derivation 这次执行所依赖的 observable 与上次执行所依赖的 observable 做比较, 做出处理，分3种情况处理：
	对于不再依赖的该 derivation 的 observable 则从 observable.observers 中移除该derivation
	对于新增且依赖的该 derivation 的 observable 则把该derivation 保存到  observable.observers 中
	对于不变的，则不错任何处理
 */
function bindDependencies(derivation: IDerivation) {
	// invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");

	const prevObserving = derivation.observing;
	const observing = derivation.observing = derivation.newObserving!;

	derivation.newObserving = null; // newObserving shouldn't be needed outside tracking

	// Go through all new observables and check diffValue: (this list can contain duplicates):
	//   0: first occurence, change to 1 and keep it
	//   1: extra occurence, drop it
	let i0 = 0, l = derivation.unboundDepsCount;
	for (let i = 0; i < l; i++) {
		const dep = observing[i];
		if (dep.diffValue === 0) {
			dep.diffValue = 1;
			if (i0 !== i) observing[i0] = dep;
			i0++;
		}
	}
	observing.length = i0;

	// Go through all old observables and check diffValue: (it is unique after last bindDependencies)
	//   0: it's not in new observables, unobserve it
	//   1: it keeps being observed, don't want to notify it. change to 0
	l = prevObserving.length;
	while (l--) {
		const dep = prevObserving[l];
		if (dep.diffValue === 0) {
			removeObserver(dep, derivation);
		}
		dep.diffValue = 0;
	}

	// Go through all new observables and check diffValue: (now it should be unique)
	//   0: it was set to 0 in last loop. don't need to do anything.
	//   1: it wasn't observed, let's observe it. set back to 0
	while (i0--) {
		const dep = observing[i0];
		if (dep.diffValue === 1) {
			dep.diffValue = 0;
			addObserver(dep, derivation);
		}
	}
}

export function clearObserving(derivation: IDerivation) {
	// invariant(globalState.inBatch > 0, "INTERNAL ERROR clearObserving should be called only inside batch");
	const obs = derivation.observing;
	let i = obs.length;
	while (i--)
		removeObserver(obs[i], derivation);

	derivation.dependenciesState = IDerivationState.NOT_TRACKING;
	obs.length = 0;
}

export function untracked<T>(action: () => T): T {
	const prev = untrackedStart();
	const res = action();
	untrackedEnd(prev);
	return res;
}

export function untrackedStart(): IDerivation | null {
	const prev = globalState.trackingDerivation;
	globalState.trackingDerivation = null;
	return prev;
}

export function untrackedEnd(prev: IDerivation | null) {
	globalState.trackingDerivation = prev;
}

/**
 * needed to keep `lowestObserverState` correct. when changing from (2 or 1) to 0
 *
 */
export function changeDependenciesStateTo0(derivation: IDerivation) {
	if (derivation.dependenciesState === IDerivationState.UP_TO_DATE) return;
	derivation.dependenciesState = IDerivationState.UP_TO_DATE;

	const obs = derivation.observing;
	let i = obs.length;
	while (i--)
		obs[i].lowestObserverState = IDerivationState.UP_TO_DATE;
}
