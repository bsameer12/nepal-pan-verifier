import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROMIUM_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

// Force AL2023 environment detection for @sparticuz/chromium on Vercel
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';

let cachedBrowser = null;

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.query?.test === '1') {
    try {
      const t0 = Date.now();
      const resp = await fetch('https://ird.gov.np/pan-search/', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(6000)
      });
      const text = await resp.text();
      return res.status(200).json({
        timeMs: Date.now() - t0,
        status: resp.status,
        hasForm: text.includes('getPanSearch'),
        length: text.length
      });
    } catch (e) {
      return res.status(500).json({
        error: e.message
      });
    }
  }

  // Extract PAN from query or body
  const rawPan = req.query?.pan || req.body?.pan || '';
  const pan = String(rawPan).replace(/\D/g, '');

  if (pan.length !== 9) {
    return res.status(400).json({
      success: false,
      pan: pan,
      message: 'PAN number must be exactly 9 numeric digits.'
    });
  }

  const t0 = Date.now();
  const marks = {};

  let browser = null;
  try {
    const fs = await import('node:fs');
    if (fs.existsSync('/tmp/chromium') && !fs.existsSync('/tmp/al2023/lib/libnss3.so')) {
      try {
        fs.unlinkSync('/tmp/chromium');
      } catch (e) {}
    }

    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath(CHROMIUM_URL);
    marks.executable = Date.now() - t0;

    const al2023Lib = '/tmp/al2023/lib';
    if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.includes(al2023Lib)) {
      process.env.LD_LIBRARY_PATH = [al2023Lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-features=CrossOriginOpenerPolicy,CrossOriginEmbedderPolicy',
        '--hide-scrollbars'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless
    });
    marks.browserReady = Date.now() - t0;

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    // Navigate to lightweight origin anchor to avoid COOP/SPA frame detachment
    await page.goto('https://ird.gov.np/robots.txt', {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    marks.pageNavigated = Date.now() - t0;

    // Execute within genuine ird.gov.np origin
    const execResult = await page.evaluate(async (panNum) => {
      try {
        // 1. Fetch /pan-search/ to establish real CSRF token & session cookie
        const panPage = await fetch('/pan-search/');
        const text = await panPage.text();
        const match = text.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
        const csrfToken = match ? match[1] : '';

        return new Promise((resolve) => {
          // 2. Load Google reCAPTCHA explicit script
          const script = document.createElement('script');
          script.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
          script.onload = () => {
            if (typeof window.grecaptcha === 'undefined') {
              return resolve({ success: false, error: 'grecaptcha_undefined' });
            }

            window.grecaptcha.ready(() => {
              const container = document.createElement('div');
              container.id = 'recaptcha-box';
              document.body.appendChild(container);

              try {
                const widgetId = window.grecaptcha.render('recaptcha-box', {
                  sitekey: '6LdZWZ8pAAAAAAfBIJLQaO6RNoYDSVDNfc-avUhy',
                  size: 'invisible',
                  callback: async (captchaToken) => {
                    try {
                      const fd = new FormData();
                      fd.append('csrfmiddlewaretoken', csrfToken);
                      fd.append('pan', panNum);
                      fd.append('g-recaptcha-response', captchaToken);

                      const postResp = await fetch('/api/getPanSearch/', {
                        method: 'POST',
                        headers: {
                          'X-CSRFToken': csrfToken,
                          'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: fd
                      });

                      const json = await postResp.json();
                      resolve({ success: true, json: json });
                    } catch (postErr) {
                      resolve({ success: false, error: 'post_failed: ' + postErr.message });
                    }
                  }
                });

                window.grecaptcha.execute(widgetId);
              } catch (renderErr) {
                resolve({ success: false, error: 'render_failed: ' + renderErr.message });
              }
            });
          };

          script.onerror = () => resolve({ success: false, error: 'script_load_failed' });
          document.head.appendChild(script);

          setTimeout(() => resolve({ success: false, error: 'recaptcha_timeout' }), 10000);
        });
      } catch (outerErr) {
        return { success: false, error: 'eval_failed: ' + outerErr.message };
      }
    }, pan);

    marks.evaluateFinished = Date.now() - t0;

    await browser.close();
    browser = null;

    if (execResult?.success && execResult?.json) {
      const payload = execResult.json;
      if (payload.code === 1 || payload.data) {
        return res.status(200).json({
          success: true,
          pan: pan,
          timing: marks,
          data: payload.data || payload,
          source: 'IRD Nepal Official Portal'
        });
      }
    }

    return res.status(404).json({
      success: false,
      pan: pan,
      timing: marks,
      evalResult: execResult,
      message: 'Taxpayer record not found or unverified on IRD portal'
    });
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return res.status(500).json({
      success: false,
      pan: pan,
      timing: marks,
      message: error.message || 'Serverless verification error'
    });
  }
}
