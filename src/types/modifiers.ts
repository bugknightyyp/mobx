export interface IEnhancer<T> {
	(newValue: T, oldValue: T | undefined, name: string): T;
}

export interface IModifierDescriptor<T> {// 修饰符描述符号规范
	isMobxModifierDescriptor: boolean;
	initialValue: T | undefined;
	enhancer: IEnhancer<T>;
}

export function isModifierDescriptor(thing): thing is IModifierDescriptor<any> {
	return typeof thing === "object" && thing !== null && thing.isMobxModifierDescriptor === true;
}

export function createModifierDescriptor<T>(enhancer: IEnhancer<T>, initialValue: T): IModifierDescriptor<T> {
	invariant(!isModifierDescriptor(initialValue), "Modifiers cannot be nested");
	return {
		isMobxModifierDescriptor: true,
		initialValue,
		enhancer
	};
}
// 修饰器决定处理数据的方案
export function deepEnhancer(v, _, name) {// deep: 遍历递归所有的字段，都处理成 observable
	if (isModifierDescriptor(v))
		fail("You tried to assign a modifier wrapped value to a collection, please define modifiers when creating the collection, not when modifying it");

	// it is an observable already, done
	if (isObservable(v))
		return v;

	// something that can be converted and mutated?
	if (Array.isArray(v))
		return observable.array(v, name);
	if (isPlainObject(v))
		return observable.object(v, name);
	if (isES6Map(v))
		return observable.shallowMap(v, name);

	return v;// 如果是 primitive 类型 就不处理了
}

export function shallowEnhancer(v, _, name): any {// shallow: 只将第一级的字段处理成observable
	if (isModifierDescriptor(v))
		fail("You tried to assign a modifier wrapped value to a collection, please define modifiers when creating the collection, not when modifying it");

	if (v === undefined || v === null)
		return v;
	if (isObservableObject(v) || isObservableArray(v) || isObservableMap(v))
		return v;
	if (Array.isArray(v))
		return observable.shallowArray(v, name);
	if (isPlainObject(v))
		return observable.shallowObject(v, name);
	if (isES6Map(v))
		return observable.shallowMap(v, name);

	return fail("The shallow modifier / decorator can only used in combination with arrays, objects and maps");
}

export function referenceEnhancer(newValue?) {// reference: 不做任何处理
	// never turn into an observable
	return newValue;
}

export function deepStructEnhancer(v, oldValue, name): any {
	// don't confuse structurally compare enhancer with ref enhancer! The latter is probably
	// more suited for immutable objects
	if (deepEqual(v, oldValue))
		return oldValue;

	// it is an observable already, done
	if (isObservable(v))
		return v;

	// something that can be converted and mutated?
	if (Array.isArray(v))
		return new ObservableArray(v, deepStructEnhancer, name);
	if (isES6Map(v))
		return new ObservableMap(v, deepStructEnhancer, name);
	if (isPlainObject(v)) {
		const res = {};
		asObservableObject(res, name);
		extendObservableHelper(res, deepStructEnhancer, [v]);
		return res;
	}

	return v;
}

export function refStructEnhancer(v, oldValue, name): any {
	if (deepEqual(v, oldValue))
		return oldValue;
	return v;
}

import { isObservable } from "../api/isobservable";
import { observable } from "../api/observable";
import { extendObservableHelper } from "../api/extendobservable";
import { fail, isPlainObject, invariant, isES6Map, deepEqual } from "../utils/utils";
import { isObservableObject, asObservableObject } from "./observableobject";
import { isObservableArray, ObservableArray } from "./observablearray";
import { isObservableMap, ObservableMap } from "./observablemap";
