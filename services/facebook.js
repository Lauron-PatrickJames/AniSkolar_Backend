// Facebook Pages API client — the only place AniSkolar talks to the Graph
// API. AniSkolar is the source of truth: announcements are pushed to the
// Page (publish / update / delete) and nothing is read back.
//
// Configuration (server-side only; never sent to the frontend):
//   FB_PAGE_ID            numeric id of the AdSO Facebook Page
//   FB_PAGE_ACCESS_TOKEN  long-lived Page access token with pages_manage_posts
//   FB_GRAPH_VERSION      Graph API version, e.g. "v23.0"
//
// Uses Node's built-in fetch / FormData / Blob (Node 18+), so there are no
// extra dependencies. Every call has a timeout and every failure is thrown
// as a FacebookError carrying a message an admin can act on.

const REQUEST_TIMEOUT_MS = 20000;

/**
 * @typedef {Object} FacebookImage
 * @property {Buffer} buffer
 * @property {string} filename
 * @property {string} mimetype
 */

/**
 * @typedef {Object} PublishResult
 * @property {string} postId     Page post id ("{page-id}_{post-id}")
 * @property {string} permalink  https://www.facebook.com/{post-id}
 */

class FacebookError extends Error {
  /**
   * @param {string} message  Admin-facing explanation.
   * @param {{ code?: number|string, subcode?: number, status?: number, fbtraceId?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'FacebookError';
    this.code = details.code;
    this.subcode = details.subcode;
    this.status = details.status;
    this.fbtraceId = details.fbtraceId;
  }

  /** True when the Page access token is expired, revoked or invalid. */
  get isTokenError() {
    return this.code === 190;
  }
}

function getConfig() {
  return {
    pageId: process.env.FB_PAGE_ID,
    token: process.env.FB_PAGE_ACCESS_TOKEN,
    version: process.env.FB_GRAPH_VERSION,
  };
}

/** Whether all three FB_* variables are set. */
function isConfigured() {
  const { pageId, token, version } = getConfig();
  return Boolean(pageId && token && version);
}

function requireConfig() {
  const config = getConfig();
  if (!config.pageId || !config.token || !config.version) {
    throw new FacebookError(
      'Facebook posting isn\'t set up on the server. Set FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN and FB_GRAPH_VERSION, then retry.',
      { code: 'NOT_CONFIGURED' }
    );
  }
  return config;
}

function permalinkFor(postId) {
  return `https://www.facebook.com/${postId}`;
}

// Turns a Graph API error payload into an admin-facing message.
function describeGraphError(err) {
  const code = err?.code;
  const subcode = err?.error_subcode;
  if (code === 190) {
    return 'The Facebook Page access token has expired or is no longer valid. Generate a new long-lived Page access token and update FB_PAGE_ACCESS_TOKEN on the server, then retry.';
  }
  if (code === 10 || code === 200 || (typeof code === 'number' && code > 200 && code < 300)) {
    return `Facebook refused the request: the Page access token is missing the pages_manage_posts permission, or the app isn't allowed to post to this Page yet. Check that FB_PAGE_ACCESS_TOKEN is the Page's own token (Access Token Debugger → Type: Page).${facebookSays(err)}`;
  }
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return 'Facebook is rate-limiting requests from this app. Wait a few minutes, then retry.';
  }
  if (code === 368) {
    return 'Facebook temporarily blocked this post. Check the Page for warnings, then retry later.';
  }
  if (code === 100 && subcode === 33) {
    return 'The Facebook post no longer exists or can\'t be edited by this app.';
  }
  return `Facebook returned an error: ${err?.message || 'unknown error'}`;
}

// Facebook's own wording, appended to our explanations to help diagnose
// setup problems. Graph error messages never include the access token.
function facebookSays(err) {
  return err?.message ? ` (Facebook: "${err.message}")` : '';
}

/**
 * Low-level Graph request. `body` is either URLSearchParams (form fields)
 * or FormData (multipart). The access token is always added here.
 */
async function graphRequest(method, path, body) {
  const { token, version } = requireConfig();
  let url = `https://graph.facebook.com/${version}/${path}`;
  let payload = body;

  if (method === 'DELETE' || !payload) {
    url += `?${new URLSearchParams({ access_token: token })}`;
    payload = undefined;
  } else {
    payload.append('access_token', token);
  }

  let response;
  try {
    response = await fetch(url, { method, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new FacebookError(
      timedOut ? 'Facebook didn\'t respond in time. Retry in a moment.' : 'Couldn\'t reach Facebook. Check the server\'s internet connection, then retry.',
      { code: 'NETWORK' }
    );
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    const err = json.error || {};
    throw new FacebookError(describeGraphError(err), {
      code: err.code,
      subcode: err.error_subcode,
      status: response.status,
      fbtraceId: err.fbtrace_id,
    });
  }
  return json;
}

/**
 * Publishes a post to the Page: a text post via /{page-id}/feed, a photo
 * post via /{page-id}/photos for one image, or a multi-photo post (images
 * uploaded unpublished, then attached to a /feed post) for several.
 * @param {{ message: string, link?: string, images?: FacebookImage[] }} input
 * @returns {Promise<PublishResult>}
 */
async function publishPost({ message, link, images = [] }) {
  const { pageId } = requireConfig();
  try {
    return await createPost(pageId, { message, link, images });
  } catch (err) {
    // On a new post, "object does not exist" means the Page itself: a wrong
    // FB_PAGE_ID, or a token that isn't this Page's access token.
    if (err instanceof FacebookError && err.code === 100 && err.subcode === 33) {
      throw new FacebookError(
        `Facebook can't find the Page ${pageId}, or the access token can't post to it. Check that FB_PAGE_ID is the Page's numeric ID and FB_PAGE_ACCESS_TOKEN is that Page's own token (from /me/accounts, not a user token), then restart the server and retry.`,
        { code: err.code, subcode: err.subcode, status: err.status, fbtraceId: err.fbtraceId }
      );
    }
    throw err;
  }
}

function photoForm(image) {
  const form = new FormData();
  form.append('source', new Blob([image.buffer], { type: image.mimetype }), image.filename || 'image.jpg');
  return form;
}

async function createPost(pageId, { message, link, images }) {
  if (images.length === 1) {
    const form = photoForm(images[0]);
    form.append('message', message);
    form.append('published', 'true');
    const json = await graphRequest('POST', `${pageId}/photos`, form);
    // /photos returns the photo id plus the id of the Page post wrapping it;
    // the post id is what can be edited, deleted and linked to.
    const postId = json.post_id || `${pageId}_${json.id}`;
    return { postId, permalink: permalinkFor(postId) };
  }

  const params = new URLSearchParams({ message });
  if (images.length > 1) {
    // Upload each photo unpublished (one at a time to keep memory and rate
    // limits in check), then attach them all to a single feed post.
    for (const [i, image] of images.entries()) {
      const form = photoForm(image);
      form.append('published', 'false');
      const json = await graphRequest('POST', `${pageId}/photos`, form);
      params.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: json.id }));
    }
  } else if (link) {
    params.append('link', link);
  }
  const json = await graphRequest('POST', `${pageId}/feed`, params);
  return { postId: json.id, permalink: permalinkFor(json.id) };
}

/**
 * Replaces the text of an existing post. Facebook only lets an app edit
 * posts it created, and a photo post's images can't be changed this way —
 * callers delete and republish for that.
 * @param {string} postId
 * @param {string} message
 * @returns {Promise<void>}
 */
async function updatePost(postId, message) {
  await graphRequest('POST', postId, new URLSearchParams({ message }));
}

/**
 * Deletes a post. A post that's already gone counts as deleted.
 * @param {string} postId
 * @returns {Promise<{ alreadyGone: boolean }>}
 */
async function deletePost(postId) {
  try {
    await graphRequest('DELETE', postId);
    return { alreadyGone: false };
  } catch (err) {
    if (err instanceof FacebookError && err.code === 100 && (err.subcode === 33 || err.status === 404)) {
      return { alreadyGone: true };
    }
    throw err;
  }
}

/** The Facebook post text for an announcement: title, blank line, body. */
function composeMessage({ title, content }) {
  return `${(title || '').trim()}\n\n${(content || '').trim()}`.trim();
}

module.exports = {
  FacebookError,
  isConfigured,
  publishPost,
  updatePost,
  deletePost,
  composeMessage,
  permalinkFor,
};
