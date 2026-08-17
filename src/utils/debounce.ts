export function debounce<T extends (...args: never[]) => unknown>(
  fn: T,
  ms: number,
): { (...args: Parameters<T>): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const cancel = () => clearTimeout(timer);
  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = cancel;
  return debounced;
}
