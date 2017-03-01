import {BaseAtom} from "../core/atom";
import {checkIfStateModificationsAreAllowed} from "../core/derivation";
import {Lambda, getNextId, createInstanceofPredicate, primitiveSymbol, toPrimitive} from "../utils/utils";
import {hasInterceptors, IInterceptable, IInterceptor, registerInterceptor, interceptChange} from "./intercept-utils";
import {IListenable, registerListener, hasListeners, notifyListeners} from "./listen-utils";
import {isSpyEnabled, spyReportStart, spyReportEnd, spyReport} from "../core/spy";
import {IEnhancer} from "../types/modifiers";

export interface IValueWillChange<T> {
	object: any;
	type: "update";
	newValue: T;
}

export interface IValueDidChange<T> extends IValueWillChange<T> {
	oldValue: T | undefined;
}

export type IUNCHANGED = {};

export const UNCHANGED: IUNCHANGED = {};


export interface IObservableValue<T> {
	get(): T;
	set(value: T): void;
	intercept(handler: IInterceptor<IValueWillChange<T>>): Lambda;// 注册拦截器
	observe(listener: (change: IValueDidChange<T>) => void, fireImmediately?: boolean): Lambda; // 注册监听器
	/*
		拦截器和监听器的区别：前者是在数据变化时，拦截该数据，可以修改它作为变化值，后者是接受变化值，执行listener;
		observe 注册的 listener 和 derivation 机制还不一样，查看 setNewValue 方法
	*/
}

declare var Symbol;

export class ObservableValue<T> extends BaseAtom implements IObservableValue<T>, IInterceptable<IValueWillChange<T>>, IListenable {
	hasUnreportedChange = false;
	interceptors;
	changeListeners;
	protected value;

	constructor(value: T, protected enhancer: IEnhancer<T>, name = "ObservableValue@" + getNextId(), notifySpy = true) {
		super(name);
		this.value = enhancer(value, undefined, name);
		if (notifySpy && isSpyEnabled()) {
			// only notify spy if this is a stand-alone observable
			spyReport({ type: "create", object: this, newValue: this.value });
		}
	}

	public set(newValue: T) {
		const oldValue = this.value;
		newValue = this.prepareNewValue(newValue) as any;
		if (newValue !== UNCHANGED) {
			const notifySpy = isSpyEnabled();
			if (notifySpy) {//通知间谍
				spyReportStart({
					type: "update",
					object: this,
					newValue, oldValue
				});
			}
			this.setNewValue(newValue);
			if (notifySpy)
				spyReportEnd();
		}
	}

	private prepareNewValue(newValue): T | IUNCHANGED {// 主要做了2件事： 执行ObservableValue的拦截器，调用enhancer将新数据observable化
		checkIfStateModificationsAreAllowed();
		if (hasInterceptors(this)) {
			const change = interceptChange<IValueWillChange<T>>(this, { object: this, type: "update", newValue });//执行拦截器
			if (!change)
				return UNCHANGED;
			newValue = change.newValue;
		}
		// apply modifier
		newValue = this.enhancer(newValue, this.value, this.name);// 将新数据observable化
		return this.value !== newValue
			? newValue
			: UNCHANGED
		;
	}

	setNewValue(newValue: T) {// 设置新值，通知变化，调用listeners
		const oldValue = this.value;
		this.value = newValue;
		this.reportChanged();// 执行 derivations
		if (hasListeners(this)) {//执行 listeners
			notifyListeners(this, {
				type: "update",
				object: this,
				newValue,
				oldValue
			});
		}
	}

	public get(): T {
		this.reportObserved();
		return this.value;
	}

	public intercept(handler: IInterceptor<IValueWillChange<T>>): Lambda {// 注册拦截器
		return registerInterceptor(this, handler);
	}

	public observe(listener: (change: IValueDidChange<T>) => void, fireImmediately?: boolean): Lambda {// 注册监听器
		if (fireImmediately)// 决定是否是刚注册就执行
			listener({
				object: this,
				type: "update",
				newValue: this.value,
				oldValue: undefined
			});
		return registerListener(this, listener);
	}

	toJSON() {
		return this.get();
	}

	toString() {
		return `${this.name}[${this.value}]`;
	}

	valueOf(): T {
		return toPrimitive(this.get());
	}
}

ObservableValue.prototype[primitiveSymbol()] = ObservableValue.prototype.valueOf;

export const isObservableValue = createInstanceofPredicate("ObservableValue", ObservableValue);
