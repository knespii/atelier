// Google Tasks: the tasks of the Google account in GNOME's Online Accounts.
// The shell asks Online Accounts for an access token (kept in memory only)
// and talks to the Tasks API with it. These are the API's addresses and
// the reading of its answers.

export const SCOPE = 'https://www.googleapis.com/auth/tasks';
const API = 'https://tasks.googleapis.com/tasks/v1';

/** @returns {string} the task lists of the account */
export const listsUrl = () => `${API}/users/@me/lists?maxResults=20`;

/**
 * @param {string} list - a list's id
 * @returns {string} the open tasks of a list
 */
export const tasksUrl = list =>
    `${API}/lists/${encodeURIComponent(list)}/tasks?showCompleted=false&showHidden=false&maxResults=50`;

/**
 * @param {string} list
 * @param {string} task
 * @returns {string} one task, e.g. to mark it done
 */
export const taskUrl = (list, task) => `${API}/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(task)}`;

/** The change that marks a task done. */
export const COMPLETE = JSON.stringify({status: 'completed'});

/**
 * @param {string} json - the answer to listsUrl()
 * @returns {object[]} [{id, title}]
 */
export function parseLists(json) {
    const items = JSON.parse(json)?.items;
    return Array.isArray(items)
        ? items.filter(item => item?.id).map(item => ({id: item.id, title: item.title ?? ''}))
        : [];
}

/**
 * @param {string} json - the answer to tasksUrl()
 * @returns {object[]} [{id, title, due}] the open tasks with a title, those
 *   due soonest first (due is a Date or null), then in the list's order
 */
export function parseTasks(json) {
    const items = JSON.parse(json)?.items;
    if (!Array.isArray(items))
        return [];
    return items
        .filter(item => item?.id && item.status !== 'completed' && !item.deleted && item.title?.trim())
        .map((item, index) => ({
            id: item.id,
            title: item.title.trim(),
            due: item.due ? new Date(item.due) : null,
            position: item.position ?? String(index).padStart(20, '0'),
        }))
        .sort((a, b) => {
            if (a.due && b.due)
                return a.due - b.due;
            if (a.due || b.due)
                return a.due ? -1 : 1;
            return a.position.localeCompare(b.position);
        })
        .map(({id, title, due}) => ({id, title, due}));
}
