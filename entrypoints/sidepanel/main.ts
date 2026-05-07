import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { library } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';
import { faPenToSquare } from '@fortawesome/free-regular-svg-icons';
import {
  faBold,
  faCheck,
  faCloudArrowUp,
  faCode,
  faEraser,
  faFileCirclePlus,
  faFloppyDisk,
  faFolderPlus,
  faFolderTree,
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
  faStrikethrough,
  faTrashCan,
  faUnderline,
  faVideo,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import App from './App.vue';
import '@/src/styles/global.css';

library.add(
  faBold,
  faCheck,
  faCloudArrowUp,
  faCode,
  faEraser,
  faFileCirclePlus,
  faFloppyDisk,
  faFolderPlus,
  faFolderTree,
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
  faStrikethrough,
  faTrashCan,
  faUnderline,
  faVideo,
  faWandMagicSparkles,
  faXmark,
);

createApp(App)
  .component('font-awesome-icon', FontAwesomeIcon)
  .use(createPinia())
  .mount('#app');
