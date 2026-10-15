export class SessionHistory {
  constructor(limit = 40) {
    this.limit = limit;
    this.items = [];
  }

  add(book, collectionName) {
    const item = {
      bookId: book.id,
      name: book.name,
      collectionName,
      openedAt: new Date()
    };
    this.items.unshift(item);
    if (this.items.length > this.limit) this.items.length = this.limit;
    return item;
  }

  clear() {
    this.items = [];
  }

  renameBook(oldId, book) {
    for (const item of this.items) {
      if (item.bookId !== oldId) continue;
      item.bookId = book.id;
      item.name = book.name;
    }
  }
}
