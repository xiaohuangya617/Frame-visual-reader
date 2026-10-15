export function pageWheelAction({ deltaY, scrollTop, scrollHeight, clientHeight }) {
  if (Math.abs(deltaY) < 1) return 'ignore';
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const canScroll = maxScrollTop > 2;
  const atTop = scrollTop <= 2;
  const atBottom = scrollTop >= maxScrollTop - 2;
  if (canScroll && ((deltaY > 0 && !atBottom) || (deltaY < 0 && !atTop))) return 'scroll';
  return deltaY > 0 ? 'next' : 'previous';
}
