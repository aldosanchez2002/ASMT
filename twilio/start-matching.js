// Twilio Function: starts the "Read receipts" GitHub Action when work is
// logged in the app, so the parts bought for it get matched in a minute or
// two instead of waiting for the hourly run.
//
// The app (web/app.js, startMatchingSoon) posts here a few seconds after a
// work entry is saved, once its Undo has passed. The GitHub token stays here:
// the website is public and can't hold it. Anyone could call this, but all it
// does is start a run that stops after a few reads when nothing changed, and
// GitHub keeps at most one run waiting.
//
// Lives in Twilio (Functions & Assets, the same "receipts" service as
// whatsapp-receipt.js), path /start-matching, visibility Public. Setup:
// twilio/README.md. Uses the service's GITHUB_TOKEN environment variable.

const WORKFLOW = 'https://api.github.com/repos/aldosanchez2002/ASMT/actions/workflows/read-receipts.yml/dispatches';

exports.handler = async (context, event, callback, { fetchFn = fetch } = {}) => {
  const res = new Twilio.Response();
  res.appendHeader('Access-Control-Allow-Origin', 'https://aslog.dev');
  res.appendHeader('Content-Type', 'application/json');
  const reply = (status, body) => {
    res.setStatusCode(status);
    res.setBody(body);
    return callback(null, res);
  };
  if (event.app !== 'aslog') return reply(400, { ok: false });
  if (!context.GITHUB_TOKEN) return reply(503, { ok: false, why: 'no GITHUB_TOKEN' });
  try {
    const gh = await fetchFn(WORKFLOW, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aslog-receipts', 'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!gh.ok) console.error(`start matching: GitHub ${gh.status}`);
    return reply(gh.ok ? 200 : 502, { ok: gh.ok });
  } catch (err) {
    console.error(`start matching: ${err.message}`);
    return reply(502, { ok: false });
  }
};
