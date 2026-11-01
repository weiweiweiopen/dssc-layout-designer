/** Keep worker/WebGL test teardown bounded; only terminate the Chrome child
 * launched by this test, never a user's browser or the app server. */
export async function closeTestBrowser(browser) {
  const debug = (text) => { if (process.env.TEST_CLEANUP_DEBUG) console.error(`[browser cleanup] ${text}`); };
  debug(`begin pid=${browser.process()?.pid}`);
  let timeout;
  const closed = await Promise.race([
    browser.close().then(() => true, () => false),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 5000); timeout.unref(); }),
  ]);
  clearTimeout(timeout);
  debug(`graceful=${closed}`);
  if (!closed) {
    const child = browser.process();
    browser.disconnect();
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
  debug(`done resources=${process.getActiveResourcesInfo().join(',')}`);
}
