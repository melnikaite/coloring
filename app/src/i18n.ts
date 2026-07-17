/**
 * Lightweight i18n. The app is deliberately icon-only (kids can't read), so
 * the entire string set is tooltips (`title`), the search placeholder and
 * img alt texts - nothing here affects layout. Unknown locales and missing
 * keys fall back to English per-key.
 */

const en = {
  home: 'Back to gallery',
  resetView: 'Fit page to screen',
  undo: 'Undo',
  redo: 'Redo',
  celebrate: 'Celebrate!',
  shareImage: 'Share / save image',
  sharePicture: 'Share / save picture',
  shareAnimation: 'Share / save animation',
  toolFill: 'Fill',
  toolBrush: 'Brush',
  toolMarker: 'Marker',
  toolEraser: 'Eraser',
  sizeSmall: 'Small brush',
  sizeMedium: 'Medium brush',
  sizeLarge: 'Large brush',
  modeToggle: 'Toggle inside-lines / free painting',
  search: 'Search',
  closeSearch: 'Close search',
  searchPlaceholder: 'cat, dog, red car…',
  downloadCategory: 'Download for offline',
  deleteWork: 'Delete',
  myWorkAlt: 'My coloring',
  confirmYes: 'Yes',
  confirmNo: 'No',
  frame1: 'Frame 1',
  frame2: 'Frame 2',
  copyColors: 'Copy colors from frame 1',
  continueWork: 'Continue',
  newWork: 'New',
};

export type MessageKey = keyof typeof en;

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = {
  en,
  ru: {
    home: 'Назад в галерею',
    resetView: 'Показать всю страницу',
    undo: 'Отменить',
    redo: 'Вернуть',
    celebrate: 'Праздник!',
    shareImage: 'Поделиться / сохранить картинку',
    sharePicture: 'Поделиться / сохранить картинку',
    shareAnimation: 'Поделиться / сохранить анимацию',
    toolFill: 'Заливка',
    toolBrush: 'Кисть',
    toolMarker: 'Маркер',
    toolEraser: 'Ластик',
    sizeSmall: 'Тонкая кисть',
    sizeMedium: 'Средняя кисть',
    sizeLarge: 'Толстая кисть',
    modeToggle: 'Режим: внутри линий / свободно',
    search: 'Поиск',
    closeSearch: 'Закрыть поиск',
    searchPlaceholder: 'кот, собака, красная машина…',
    downloadCategory: 'Скачать для офлайна',
    deleteWork: 'Удалить',
    myWorkAlt: 'Моя раскраска',
    confirmYes: 'Да',
    confirmNo: 'Нет',
    frame1: 'Кадр 1',
    frame2: 'Кадр 2',
    copyColors: 'Скопировать цвета с кадра 1',
    continueWork: 'Продолжить',
    newWork: 'Новая',
  },
  de: {
    home: 'Zurück zur Galerie',
    resetView: 'Seite einpassen',
    undo: 'Rückgängig',
    redo: 'Wiederholen',
    celebrate: 'Feiern!',
    shareImage: 'Bild teilen / speichern',
    sharePicture: 'Bild teilen / speichern',
    shareAnimation: 'Animation teilen / speichern',
    toolFill: 'Füllen',
    toolBrush: 'Pinsel',
    toolMarker: 'Marker',
    toolEraser: 'Radiergummi',
    sizeSmall: 'Kleiner Pinsel',
    sizeMedium: 'Mittlerer Pinsel',
    sizeLarge: 'Großer Pinsel',
    modeToggle: 'Modus: in den Linien / frei malen',
    search: 'Suche',
    closeSearch: 'Suche schließen',
    searchPlaceholder: 'Katze, Hund, rotes Auto…',
    downloadCategory: 'Für offline herunterladen',
    deleteWork: 'Löschen',
    myWorkAlt: 'Mein Ausmalbild',
    confirmYes: 'Ja',
    confirmNo: 'Nein',
    frame1: 'Bild 1',
    frame2: 'Bild 2',
    copyColors: 'Farben von Bild 1 kopieren',
    continueWork: 'Weiter',
    newWork: 'Neu',
  },
};

export const locale: string = (navigator.languages?.[0] || navigator.language || 'en').slice(0, 2).toLowerCase();

/** Returns the localized string for `key`, falling back to English. */
export function t(key: MessageKey): string {
  return dictionaries[locale]?.[key] ?? en[key];
}
