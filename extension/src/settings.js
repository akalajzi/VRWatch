import { readPreferences, updatePreferences } from './preferences.js';
import { readRecent, clearRecent } from './recent.js';
import { readBookmarkState, changeBookmarks } from './bookmarks.js';
import { mountManagePage, showMessage } from './manage-page.js';
const checkbox = document.querySelector('#show-quick-links');
async function refresh() {
  try {
    const [bookmarks, preferences] = await Promise.all([readBookmarkState(), readPreferences()]);
    checkbox.checked = bookmarks.showQuickLinks;
    for (const field of document.querySelectorAll('[data-preference]')) {
      if (field.disabled) continue;
      if (field.type === 'checkbox') field.checked = preferences[field.dataset.preference];
      else field.value = String(preferences[field.dataset.preference]);
    }
  }
  catch (error) { showMessage(error.message, true); }
}
mountManagePage(refresh);
checkbox.addEventListener('change', async () => {
  checkbox.disabled = true;
  try { await changeBookmarks('visibility', { visible: checkbox.checked }); showMessage('Home preference saved.'); }
  catch (error) { showMessage(error.message, true); await refresh(); }
  finally { checkbox.disabled = false; }
});
const dialog = document.querySelector('#clear-dialog');
document.querySelector('#clear-previews').onclick = () => dialog.showModal();
document.querySelector('#cancel-clear').onclick = () => dialog.close();
document.querySelector('#confirm-clear').onclick = async event => {
  event.target.disabled = true;
  try { await changeBookmarks('clearPreviews'); dialog.close(); showMessage('Saved previews cleared. Your bookmarks are unchanged.'); }
  catch (error) { dialog.close(); showMessage(error.message, true); }
  finally { event.target.disabled = false; }
};
void refresh();

for (const field of document.querySelectorAll('[data-preference]')) field.addEventListener('change', async () => {
  const key = field.dataset.preference;
  const value = field.type === 'checkbox' ? field.checked : key === 'historyExpiryDays' ? Number(field.value) : field.value;
  field.disabled = true;
  try {
    await updatePreferences({ [key]: value });
    if (key === 'historyExpiryDays') await readRecent();
    showMessage(key === 'startup' ? 'Startup preference saved for the next VRWatch launch.' : 'Preference saved.');
  } catch (error) { showMessage(error.message, true); }
  finally { field.disabled = false; await refresh(); }
});
const historyDialog = document.querySelector('#history-dialog');
document.querySelector('#clear-history').onclick = () => historyDialog.showModal();
document.querySelector('#cancel-history').onclick = () => historyDialog.close();
document.querySelector('#confirm-history').onclick = async event => {
  event.target.disabled = true;
  try { await clearRecent(); historyDialog.close(); showMessage('History cleared.'); }
  catch (error) { showMessage(error.message, true); }
  finally { event.target.disabled = false; }
};
