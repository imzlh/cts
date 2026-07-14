/** Event-loop yield so libuv timers (progress UI, etc.) can run. */

const { setTimeout } = import.meta.use('timers');

/** Resolve on the next macrotask. Not a progress/UI API. */
export function yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
}
