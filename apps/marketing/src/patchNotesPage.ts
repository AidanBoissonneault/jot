import './main';
import './patch-notes.css';
import { renderPatchNotes } from './patchNotes';

renderPatchNotes(document.querySelector<HTMLElement>('#patch-notes-list'));
