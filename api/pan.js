import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROMIUM_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

// Force AL2023 environment detection for @sparticuz/chromium on Vercel
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';

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

  let browser = null;
  try {
    const fs = await import('node:fs');
    // If cached /tmp/chromium exists without /tmp/al2023/lib, clean /tmp/chromium so Sparticuz unpacks all assets
    if (fs.existsSync('/tmp/chromium') && !fs.existsSync('/tmp/al2023/lib/libnss3.so')) {
      try {
        fs.unlinkSync('/tmp/chromium');
      } catch (e) {}
    }

    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath(CHROMIUM_URL);

    // Ensure LD_LIBRARY_PATH includes /tmp/al2023/lib for NSS shared objects
    const al2023Lib = '/tmp/al2023/lib';
    if (!process.env.LD_LIBRARY_PATH || !process.env.LD_LIBRARY_PATH.includes(al2023Lib)) {
      process.env.LD_LIBRARY_PATH = [al2023Lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--hide-scrollbars',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    // Setup listener for official IRD API response
    let irdData = null;
    const responsePromise = new Promise((resolve) => {
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/api/getPanSearch/')) {
          try {
            const json = await response.json();
            resolve(json);
          } catch (e) {
            resolve(null);
          }
        }
      });
      // Safety timeout after form submission
      setTimeout(() => resolve(null), 15000);
    });

    // Navigate with waitUntil: 'commit' so in-page history.replaceState does not detach the frame
    try {
      await page.goto(`https://ird.gov.np/pan-search/?pan=${pan}`, {
        waitUntil: 'commit',
        timeout: 25000
      });
    } catch (e) {
      // Ignored: in-page history.replaceState or fast client redirects
    }

    // Wait 3.5s for page scripts, CSRF token, and reCAPTCHA to settle
    await new Promise((r) => setTimeout(r, 3500));

    // Trigger tax search
    await page.evaluate((panNum) => {
      const el = document.getElementById('pan');
      if (el) el.value = panNum;

      if (typeof window.taxSearch === 'function') {
        window.taxSearch({ preventDefault: () => {} });
      } else if (typeof window.grecaptcha !== 'undefined' && window.grecaptcha.execute) {
        window.grecaptcha.execute();
      } else {
        const btn = document.getElementById('submit');
        if (btn) btn.click();
      }
    }, pan);

    // Wait for the IRD getPanSearch response
    const json = await responsePromise;
    if (json && (json.code === 1 || json.data)) {
      irdData = json.data || json;
    }

    await browser.close();
    browser = null;

    if (irdData) {
      return res.status(200).json({
        success: true,
        pan: pan,
        data: irdData,
        source: 'IRD Nepal Official Portal'
      });
    } else {
      return res.status(404).json({
        success: false,
        pan: pan,
        message: 'Taxpayer record not found or unverified on IRD portal'
      });
    }
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return res.status(500).json({
      success: false,
      pan: pan,
      message: error.message || 'Serverless verification error'
    });
  }
}
