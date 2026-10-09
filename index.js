const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// === DAFTAR DOMAIN ALIGHT MOTION ===
const ALIGHT_DOMAINS = [
    'alight.page.link',
    'alight-creative.firebaseapp.com',
    'alightcreative.page.link',
    'alight-creative-staging.firebaseapp.com',
    'alight.to',
    'alightcreative.com'
];

// === FUNGSI CEK URL ALIGHT ===
function isAlightUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return ALIGHT_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    } catch {
        return false;
    }
}

// === HELPER: PARSE COOKIE STRING ===
function parseCookieString(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return {
            name: name.trim(),
            value: valueParts.join('=').trim(),
            domain: '.tiktok.com',
            path: '/'
        };
    }).filter(c => c.name && c.value);
}

// === ENDPOINT UTAMA ===
app.get('/api/preset', async (req, res) => {
    const videoUrl = req.query.url;
    const maxScroll = parseInt(req.query.scroll) || 10;
    const waitMs = parseInt(req.query.wait) || 3000;
    const cookie = req.query.cookie || process.env.TIKTOK_COOKIE || '';

    if (!videoUrl) {
        return res.status(400).json({
            success: false,
            error: 'Parameter "url" wajib diisi. Contoh: /api/preset?url=https://vt.tiktok.com/xxx/'
        });
    }

    if (!/tiktok\.com/i.test(videoUrl)) {
        return res.status(400).json({
            success: false,
            error: 'URL harus dari TikTok'
        });
    }

    let browser;
    const startedAt = Date.now();
    const capturedComments = [];
    const apiResponses = []; // Buat debug

    try {
        console.log(`\n[${new Date().toISOString()}] ==================`);
        console.log(`Request: ${videoUrl}`);
        console.log(`Cookie: ${cookie ? 'YES' : 'NO'}`);
        console.log(`Scroll: ${maxScroll}, Wait: ${waitMs}ms`);

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID',
            timezoneId: 'Asia/Jakarta',
            extraHTTPHeaders: {
                'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        // === TAMBAH COOKIE ===
        if (cookie) {
            const cookies = parseCookieString(cookie);
            if (cookies.length > 0) {
                await context.addCookies(cookies);
                console.log(`✅ ${cookies.length} cookies ditambahkan`);
            }
        }

        const page = await context.newPage();

        // === ANTI-DETECT BOT ===
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
            
            window.chrome = {
                runtime: {},
                loadTimes: function() {},
                csi: function() {},
                app: {}
            };
        });

        // === INTERCEPT SEMUA RESPONSE API TIKTOK ===
        page.on('response', async (response) => {
            const url = response.url();
            
            // Log semua API TikTok (buat debug)
            if (url.includes('tiktok.com/api/')) {
                apiResponses.push(url);
            }

            // === FILTER KOMENTAR ===
            if (url.includes('/api/comment/list/') && !url.includes('/reply/')) {
                try {
                    const json = await response.json();
                    const comments = json?.comments || [];
                    
                    for (const c of comments) {
                        capturedComments.push({
                            id: c.cid,
                            text: c.text || '',
                            likes: c.digg_count || 0,
                            author: c.user?.unique_id || 'unknown',
                            nickname: c.user?.nickname || '',
                            is_pinned: c.is_author_digged || false,
                            reply_count: c.reply_comment_total || 0
                        });
                    }
                    
                    console.log(`📥 Intercept ${comments.length} komentar (total: ${capturedComments.length})`);
                } catch (e) {
                    console.log(`⚠️ Gagal parse komentar: ${e.message}`);
                }
            }

            // === FILTER REPLY KOMENTAR ===
            if (url.includes('/api/comment/list/reply/')) {
                try {
                    const json = await response.json();
                    const replies = json?.comments || [];
                    
                    for (const c of replies) {
                        capturedComments.push({
                            id: c.cid,
                            text: c.text || '',
                            likes: c.digg_count || 0,
                            author: c.user?.unique_id || 'unknown',
                            nickname: c.user?.nickname || '',
                            is_reply: true,
                            reply_count: 0
                        });
                    }
                } catch (e) {}
            }
        });

        console.log('📥 Membuka halaman TikTok...');
        await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await page.waitForTimeout(5000);

        // === TUTUP POPUP LOGIN ===
        const closeSelectors = [
            '[data-e2e="modal-close-inner-button"]',
            'button[aria-label="Close"]',
            '[data-e2e="browse-close"]'
        ];

        for (const sel of closeSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    console.log(`✅ Popup ditutup`);
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (e) {}
        }

        // === TRIGGER LOAD KOMENTAR ===
        console.log(`📜 Scroll & trigger komentar...`);
        
        for (let i = 0; i < maxScroll; i++) {
            // Scroll pelan
            await page.evaluate(() => window.scrollBy(0, 300));
            await page.waitForTimeout(waitMs);
            
            // Coba klik tombol komentar kalo ada
            try {
                await page.evaluate(() => {
                    const commentBtn = document.querySelector('[data-e2e="comment-icon"]');
                    if (commentBtn) commentBtn.click();
                });
            } catch (e) {}
            
            // Scroll ke section komentar
            await page.evaluate(() => {
                const commentSection = document.querySelector('[data-e2e="comment-list"]');
                if (commentSection) {
                    commentSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            });
            
            console.log(`   Iterasi ${i + 1}/${maxScroll} - ${capturedComments.length} komentar`);
            
            // Stop kalo udah dapet banyak
            if (capturedComments.length > 200) break;
        }

        // Tunggu komentar terakhir
        await page.waitForTimeout(3000);

        // === FALLBACK: AMBIL DARI HTML ===
        const pageText = await page.evaluate(() => document.body.innerText);
        const hrefLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]'))
                .map(a => a.href)
                .filter(h => h && h.startsWith('http'));
        });

        const caption = await page.evaluate(() => {
            const meta = document.querySelector('meta[property="og:description"]');
            return meta ? meta.content : '';
        }).catch(() => '');

        await browser.close();
        browser = null;

        // === FILTER LINK ALIGHT ===
        const commentTexts = capturedComments.map(c => c.text).join('\n');
        const allText = pageText + '\n' + commentTexts;
        
        const textUrls = allText.match(/https?:\/\/[^\s]+/g) || [];
        const allUrls = [...new Set([...textUrls, ...hrefLinks])];
        const presetLinks = allUrls.filter(isAlightUrl);

        const elapsed = Date.now() - startedAt;

        console.log(`✅ Selesai ${elapsed}ms`);
        console.log(`📊 Total: ${capturedComments.length} komentar, ${presetLinks.length} preset`);
        console.log(`==================\n`);

        res.json({
            success: true,
            video: {
                url: videoUrl,
                caption: caption || null
            },
            scan: {
                total_links: allUrls.length,
                preset_found: presetLinks.length,
                comments_detected: capturedComments.length,
                api_calls: apiResponses.length,
                cookie_used: !!cookie,
                elapsed_ms: elapsed
            },
            presets: presetLinks,
            comments: capturedComments.slice(0, 100),
            all_links: allUrls.slice(0, 50)
        });

    } catch (err) {
        console.error('❌ Error:', err.message);
        if (browser) {
            try { await browser.close(); } catch {}
        }
        res.status(500).json({
            success: false,
            error: err.message,
            elapsed_ms: Date.now() - startedAt
        });
    }
});

// === ENDPOINT DEBUG ===
app.get('/api/debug', async (req, res) => {
    const videoUrl = req.query.url;
    const cookie = req.query.cookie || process.env.TIKTOK_COOKIE || '';

    if (!videoUrl) {
        return res.status(400).json({ error: 'Parameter url wajib diisi' });
    }

    let browser;
    const apiCalls = [];

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID'
        });

        if (cookie) {
            await context.addCookies(parseCookieString(cookie));
        }

        const page = await context.newPage();

        page.on('response', (response) => {
            const url = response.url();
            if (url.includes('tiktok.com/api/')) {
                apiCalls.push({
                    url: url,
                    status: response.status()
                });
            }
        });

        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => window.scrollBy(0, 300));
            await page.waitForTimeout(2000);
        }

        const pageText = await page.evaluate(() => document.body.innerText);

        await browser.close();

        res.json({
            success: true,
            api_calls: apiCalls,
            text_length: pageText.length,
            text_preview: pageText.slice(0, 2000),
            urls_found: (pageText.match(/https?:\/\/[^\s]+/g) || []).slice(0, 30)
        });

    } catch (err) {
        if (browser) await browser.close();
        res.status(500).json({ error: err.message });
    }
});

// === HEALTH CHECK ===
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'TikTok Preset Finder API',
        version: '1.2.0',
        endpoints: {
            preset: '/api/preset?url=<tiktok_url>&scroll=10&wait=3000',
            debug: '/api/debug?url=<tiktok_url>',
            health: '/health'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// === START SERVER ===
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
    console.log(`📌 Endpoint: /api/preset?url=<tiktok_url>`);
    console.log(`🐛 Debug: /api/debug?url=<tiktok_url>`);
});

// === HANDLE ERROR ===
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
