import {Lambda, once, invariant} from "../utils/utils";
import {untrackedStart, untrackedEnd} from "../core/derivation";

export type IInterceptor<T> = (change: T) => T;// 拦截器规范

export interface IInterceptable<T> {
	interceptors: IInterceptor<T>[] | null;
	intercept(handler: IInterceptor<T>): Lambda;
}

export function hasInterceptors(interceptable: IInterceptable<any>) {
	return (interceptable.interceptors && interceptable.interceptors.length > 0);
}

export function registerInterceptor<T>(interceptable: IInterceptable<T>, handler: IInterceptor<T>): Lambda {
	const interceptors = interceptable.interceptors || (interceptable.interceptors = []);
	interceptors.push(handler);
	return once(() => {
		const idx = interceptors.indexOf(handler);
		if (idx !== -1)// 若存在则删除
			interceptors.splice(idx, 1);
	});
}

export function interceptChange<T>(interceptable: IInterceptable<T>, change: T): T {// 拦截变化
	const prevU = untrackedStart();
	try {
		const interceptors = interceptable.interceptors;
		if (interceptors) for (let i = 0, l = interceptors.length; i < l; i++) {// 依次调用拦截器
			change = interceptors[i](change);
			invariant(!change || (change as any).type, "Intercept handlers should return nothing or a change object");
			if (!change)// 如果上一个interceptor返回的结果为 falsey 则不再执行后面的interceptor
				break;
		}
		return change;
	} finally {
		untrackedEnd(prevU);
	}
}
