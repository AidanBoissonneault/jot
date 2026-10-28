/** Shared application bootstrap for the Chrome panel and the local marketing preview. */
import { createApp, type App as VueApp } from 'vue';
import { createPinia } from 'pinia';
import { library } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';
import { faPenToSquare } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowDown,
  faArrowUp,
  faBold,
  faCheck,
  faChevronDown,
  faCloudArrowUp,
  faCode,
  faEraser,
  faFileCirclePlus,
  faFileLines,
  faFloppyDisk,
  faFolderPlus,
  faFolder,
  faFolderTree,
  faGear,
  faGripLines,
  faHeading,
  faHighlighter,
  faImage,
  faItalic,
  faLink,
  faListCheck,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faMicrophone,
  faPalette,
  faPhotoFilm,
  faPlus,
  faQuoteLeft,
  faRightFromBracket,
  faRotate,
  faRotateLeft,
  faRotateRight,
  faSliders,
  faStop,
  faStrikethrough,
  faTrashCan,
  faTriangleExclamation,
  faUnderline,
  faVideo,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import App from './App.vue';
import '@/src/styles/global.css';
import './sidepanel.css';

library.add(
  faArrowDown,
  faArrowUp,
  faBold,
  faCheck,
  faChevronDown,
  faCloudArrowUp,
  faCode,
  faEraser,
  faFileCirclePlus,
  faFileLines,
  faFloppyDisk,
  faFolderPlus,
  faFolder,
  faFolderTree,
  faGear,
  faGripLines,
  faHeading,
  faHighlighter,
  faImage,
  faItalic,
  faLink,
  faListCheck,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faMicrophone,
  faPalette,
  faPenToSquare,
  faPhotoFilm,
  faPlus,
  faQuoteLeft,
  faRightFromBracket,
  faRotate,
  faRotateLeft,
  faRotateRight,
  faSliders,
  faStop,
  faStrikethrough,
  faTrashCan,
  faTriangleExclamation,
  faUnderline,
  faVideo,
  faWandMagicSparkles,
  faXmark,
);

export function mountSidepanel(target: string | Element): VueApp {
  const app = createApp(App)
    .component('font-awesome-icon', FontAwesomeIcon)
    .use(createPinia());
  app.mount(target);
  return app;
}
