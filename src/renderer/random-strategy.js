export const RANDOM_STRATEGIES = Object.freeze({
  DEFAULT: 'default',
  LIKES: 'likes',
  SHORT: 'short'
});

export const RANDOM_STRATEGY_LABELS = Object.freeze({
  [RANDOM_STRATEGIES.DEFAULT]: '默认随机',
  [RANDOM_STRATEGIES.LIKES]: '点赞优先',
  [RANDOM_STRATEGIES.SHORT]: '短篇优先'
});

function isUnread(book, bookStates) {
  return bookStates?.[book.id]?.unread !== false;
}

export function booksForRandomTab(books, filter, bookStates = {}) {
  const source = Array.isArray(books) ? books : [];
  return source.filter((book) => {
    if (filter === 'unread') return isUnread(book, bookStates);
    if (filter === 'comic') return ['comic', 'pdf'].includes(book.type);
    if (filter === 'novel' || filter === 'text') return ['text', 'epub'].includes(book.type);
    return true;
  });
}

function pick(items, random) {
  if (items.length === 0) return null;
  const value = Number(random());
  const ratio = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
  return items[Math.floor(ratio * items.length)];
}

export function selectRandomBook({
  books,
  filter = 'all',
  bookStates = {},
  strategy = RANDOM_STRATEGIES.DEFAULT,
  successfulDraws = 0,
  random = Math.random
} = {}) {
  const candidates = booksForRandomTab(books, filter, bookStates);
  if (candidates.length === 0) return { book: null, candidates, prioritized: false };

  const normalizedStrategy = Object.hasOwn(RANDOM_STRATEGY_LABELS, strategy)
    ? strategy
    : RANDOM_STRATEGIES.DEFAULT;
  const prioritized = normalizedStrategy !== RANDOM_STRATEGIES.DEFAULT && successfulDraws % 4 === 3;
  let pool = candidates;

  if (prioritized && normalizedStrategy === RANDOM_STRATEGIES.LIKES) {
    const liked = candidates.filter((book) => Number(bookStates[book.id]?.likeCount) > 0);
    if (liked.length > 0) pool = liked;
  }

  if (prioritized && normalizedStrategy === RANDOM_STRATEGIES.SHORT) {
    const sorted = [...candidates].sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
    const count = Math.max(1, Math.ceil(sorted.length * 0.25));
    pool = sorted.slice(0, count);
  }

  return { book: pick(pool, random), candidates, pool, prioritized: pool !== candidates };
}

