/**
 * Whether a list filter currently holds typed text.
 *
 * `/` and `?` are global shortcuts (session search, help), but once a filter has
 * text they are ordinary filter characters. The filter and the App's global
 * handler both see every keypress, so the filter publishes its state here and
 * the App consults it — one flag instead of threading a callback through every
 * view that hosts a list.
 */
let filterTyping = false;

export const setFilterTyping = (typing: boolean): void => {
  filterTyping = typing;
};

export const isFilterTyping = (): boolean => filterTyping;
