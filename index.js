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

// === ENDPOINT UTAMA: CARI PRESET ===
app.get('/api/preset', async (req, res) => {
    const videoUrl = req.query.url;
    const cookie = req.query.cookie || process.env.TIKTOK_COOKIE || '';
    const maxComments = parseInt(req.query.max) || 200;

    if (!videoUrl) {
        return res.status(400).json({ 
            success: false, 
            error: 'Parameter "url" wajib diisi. Contoh: /api/preset?url=https://vt.tiktok.com/xxx/' 
        });
    }

    if (!/tiktok\.com/i.test(videoUrl)) {
        return res.status(400).json({ success: false, error: 'URL harus dari TikTok' });
    }

    let browser;
    const startedAt = Date.now();

    try {
        console.log(`\n[${new Date().toISOString()}] ==================`);
        console.log(`Request: ${videoUrl}`);
        console.log(`Cookie: ${cookie ? 'YES' : 'NO'}`);

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            locale: 'id-ID',
            timezoneId: 'Asia/Jakarta'
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

        // === ANTI-DETECT ===
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
            window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
        });

        // === LANGKAH 1: RESOLVE VIDEO ID ===
        console.log('📥 Resolve video ID...');
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        const finalUrl = page.url();
        const videoIdMatch = finalUrl.match(/\/video\/(\d+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : null;

        if (!videoId) {
            await browser.close();
            return res.status(400).json({ success: false, error: 'Video ID tidak ditemukan dari URL' });
        }

        console.log(`✅ Video ID: ${videoId}`);

        // === LANGKAH 2: AMBIL CAPTION ===
        const caption = await page.evaluate(() => {
            const meta = document.querySelector('meta[property="og:description"]');
            return meta ? meta.content : '';
        }).catch(() => '');

        // === LANGKAH 3: PANGGIL API KOMENTAR INTERNAL TIKTOK ===
        console.log('📥 Mengambil komentar via API internal...');
        
        const allComments = [];
        let cursor = 0;
        let hasMore = true;
        let pageCount = 0;

        while (hasMore && allComments.length < maxComments && pageCount < 10) {
            pageCount++;

            const apiUrl = 'https://www.tiktok.com/api/comment/list/?' + new URLSearchParams({
                aweme_id: videoId,
                count: '50',
                cursor: String(cursor),
                aid: '1988',
                app_language: 'id-ID',
                app_name: 'tiktok_web',
                browser_language: 'id-ID',
                browser_name: 'Mozilla',
                browser_online: 'true',
                browser_platform: 'Linux armv81',
                browser_version: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                channel: 'tiktok_web',
                cookie_enabled: 'true',
                device_platform: 'web_pc',
                focus_state: 'true',
                from_page: 'video',
                history_len: '5',
                is_fullscreen: 'false',
                is_page_visible: 'true',
                os: 'linux',
                priority_region: 'ID',
                referer: finalUrl,
                region: 'ID',
                screen_height: '800',
                screen_width: '360',
                tz_name: 'Asia/Jakarta',
                webcast_language: 'id-ID'
            }).toString();

            const result = await page.evaluate(async (url) => {
                try {
                    const res = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*'
                        }
                    });
                    const data = await res.json().catch(() => null);
                    return { status: res.status, data };
                } catch (e) {
                    return { status: 0, error: e.message };
                }
            }, apiUrl);

            console.log(`   Page ${pageCount}: status ${result.status}, ${result.data?.comments?.length || 0} komentar`);

            if (result.status !== 200 || !result.data || !result.data.comments) {
                console.log(`   ⚠️ Response: ${JSON.stringify(result.data).slice(0, 200)}`);
                break;
            }

            for (const c of result.data.comments) {
                allComments.push({
                    id: c.cid,
                    text: c.text || '',
                    likes: c.digg_count || 0,
                    author: c.user?.unique_id || 'unknown',
                    nickname: c.user?.nickname || '',
                    is_pinned: c.is_pinned || false,
                    reply_count: c.reply_comment_total || 0
                });
            }

            hasMore = result.data.has_more === 1 || result.data.has_more === true;
            cursor = result.data.cursor || (cursor + 50);

            if (!hasMore) break;
            await page.waitForTimeout(1500);
        }

        console.log(`✅ Total: ${allComments.length} komentar`);

        await browser.close();
        browser = null;

        // === LANGKAH 4: FILTER LINK ALIGHT ===
        const commentTexts = allComments.map(c => c.text).join('\n');
        const allText = commentTexts + '\n' + (caption || '');
        const urls = allText.match(/https?:\/\/[^\s]+/g) || [];
        const presetLinks = [...new Set(urls.filter(isAlightUrl))];

        const elapsed = Date.now() - startedAt;

        console.log(`✅ Selesai ${elapsed}ms - ${presetLinks.length} preset`);
        console.log(`==================\n`);

        res.json({
            success: true,
            video: {
                id: videoId,
                url: videoUrl,
                caption: caption || null
            },
            scan: {
                comments_scanned: allComments.length,
                preset_found: presetLinks.length,
                cookie_used: !!cookie,
                elapsed_ms: elapsed
            },
            presets: presetLinks,
            comments: allComments.slice(0, 50)
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

        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        const finalUrl = page.url();
        const videoIdMatch = finalUrl.match(/\/video\/(\d+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : null;

        // Test API komentar langsung
        let apiTest = null;
        if (videoId) {
            const testUrl = `https://www.tiktok.com/api/comment/list/?aweme_id=${videoId}&count=5&cursor=0`;
            apiTest = await page.evaluate(async (url) => {
                try {
                    const res = await fetch(url, { credentials: 'include' });
                    const data = await res.json().catch(() => null);
                    return {
                        status: res.status,
                        has_comments: !!(data?.comments),
                        count: data?.comments?.length || 0,
                        total: data?.total || 0,
                        error: data?.status_msg || null
                    };
                } catch (e) {
                    return { error: e.message };
                }
            }, testUrl);
        }

        await browser.close();

        res.json({
            success: true,
            video_id: videoId,
            final_url: finalUrl,
            api_test: apiTest
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
        version: '2.0.0',
        endpoints: {
            preset: '/api/preset?url=<tiktok_url>&max=200',
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
