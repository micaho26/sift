/**
 * On-demand page capture.
 *
 * Injected by the worker via `chrome.scripting.executeScript` when the user asks
 * to save a page. Not a registered content script, so it never runs anywhere the
 * user did not explicitly invoke it — which is why the extension needs no
 * `<all_urls>` host permission.
 *
 * The returned value becomes the `executeScript` result.
 */
import { capturePage } from '../lib/extract-article.ts'

export default defineUnlistedScript(() => capturePage())
