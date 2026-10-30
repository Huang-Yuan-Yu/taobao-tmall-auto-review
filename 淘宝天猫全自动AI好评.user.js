// ==UserScript==
// @name         淘宝天猫全自动AI好评（大模型·拟人化闭环）
// @namespace    https://github.com/HuangYuanyu
// @version      1.0.0
// @description  原创的淘宝/天猫全自动 AI 好评助手。一个「开始/暂停」按钮控制全自动闭环：已买到的宝贝→自动进入待评价→点「评价」→调用大模型生成评语→好评满星→设为公开→自动配图(商品主图，按分辨率过滤图标)→提交→返回列表→下一单，循环至清空。全程强拟人化：每步随机等待、评语逐字输入(随机键速+偶发停顿)、点击前鼠标移动+滚动+停顿、进页面随机滚动浏览、每单间隔随机、连续若干单后长休息、检测到验证码自动暂停。AI 通过 GM_xmlhttpRequest 调用(兼容 OpenAI 格式的大模型接口)，循环状态用 GM_setValue 跨子域保存。
// @author       HuangYuanyu
// @license      MIT
// @icon         https://www.taobao.com/favicon.ico
// @run-at       document-idle
// @noframes
// @match        *://rate.taobao.com/*
// @match        *://ratewrite.tmall.com/*
// @match        *://buyertrade.taobao.com/trade*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.chatanywhere.tech
// @connect      item.taobao.com
// @connect      detail.tmall.com
// @connect      trade.taobao.com
// @connect      img.alicdn.com
// @connect      gw.alicdn.com
// @connect      alicdn.com
// @connect      taobaocdn.com
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 🛠️ 用户配置区域（在此填写你自己的大模型 API） ====================
    const API_KEY = '';                // ★必填★ 在此粘贴你自己的 API 密钥（OpenAI / DeepSeek / 智谱GLM 等「兼容 OpenAI 格式」接口的 Key）
    const API_URL = 'https://api.chatanywhere.tech/v1/chat/completions'; // 接口地址：任何兼容 OpenAI 格式的 chat/completions 接口均可
    const MODEL_NAME = 'gpt-5.4-mini'; // 模型名称：改成你所用接口支持的模型即可

    const AUTO_CLICK_DELAY = 3000;   // 自动点击前等待基准（毫秒，拟人化时会在此上下浮动）
    const ENABLE_IMAGE = true;       // 是否自动配图
    const IMG_PER_PRODUCT = 6;       // 期望配图张数（会被平台上限自动收窄：淘宝5、天猫3）
    const UPLOAD_WAIT_TIMEOUT = 12000; // 配图上传最长等待
    const REVIEW_LEN = 80;           // 宝贝评价目标字数
    const SERVICE_LEN = 50;          // 天猫服务评价目标字数（上限100）
    const SET_PUBLIC = true;         // 有公开选项时设为公开（淘宝选“公开”、天猫取消“匿名”）

    // —— 🐢 拟人化参数（防风控核心：每步随机等待、逐字打字、鼠标移动、点击前停顿；嫌慢可整体调小）——
    const HUMAN_MODE = true;                       // 拟人化总开关（false=尽快执行，不推荐）
    const TYPE_MIN_MS = 55, TYPE_MAX_MS = 165;     // 打字每个字符的随机间隔(ms)
    const TYPE_PAUSE_EVERY = 14, TYPE_PAUSE_MS = 900; // 每输入约 N 字，随机“思考”停顿至多这么多 ms
    const STEP_MIN_MS = 900, STEP_MAX_MS = 2600;   // 步骤之间的随机等待(ms)
    const CLICK_MIN_MS = 400, CLICK_MAX_MS = 1400; // 点击前的随机停顿(ms)
    const READ_MIN_MS = 1500, READ_MAX_MS = 4200;  // 进入页面后随机“浏览”时间(ms)
    const ORDER_MIN_MS = 2500, ORDER_MAX_MS = 6000;// 每单之间的随机间隔(ms，模拟在列表里扫一眼)
    const BREAK_EVERY_MIN = 4, BREAK_EVERY_MAX = 7;   // 连续评价多少单后（随机）来一次长休息，规避风控
    const BREAK_MIN_MS = 60000, BREAK_MAX_MS = 180000;// 长休息时长(ms，1~3分钟)，模拟真人离开一会儿
    const BROWSE_SCROLL = true;                    // 进页面/列表时随机滚动“浏览”，制造真人轨迹

    const DEFAULT_LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?tabCode=waitRate';
    const WAITRATE_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm?action=itemlist%2FBoughtQueryAction&event_submit_do_query=1&tabCode=waitRate'; // “待评价”标签页直达地址
    const MIN_IMAGE_DIM = 400;       // 配图最短边阈值(px)：小于此值视为图标/小图，丢弃
    // =========================================================

    // ==================== 平台识别 ====================
    const HOST = location.host;
    const PLATFORM = /ratewrite\.tmall\.com/.test(HOST) ? 'tmall'
        : /rate\.taobao\.com/.test(HOST) ? 'taobao'
            : /buyertrade\.taobao\.com/.test(HOST) ? 'list' : 'other';

    // ==================== 循环 / 暂停 状态（跨子域，用 GM 存储） ====================
    const K_RUNNING = 'TB_AI_LOOP_RUNNING';
    const K_LISTURL = 'TB_AI_LIST_URL';
    const K_ATTEMPTS = 'TB_AI_ATTEMPTS';
    const K_ORDER_COUNT = 'TB_AI_ORDER_COUNT'; // 已连续评价单数（触发长休息用）
    const K_NEXT_BREAK = 'TB_AI_NEXT_BREAK';   // 下一次长休息前还需评价几单
    const MAX_SUBMIT_TRY = 3;

    let running = false, currentStep = null, resumeAction = null;
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    function gmGet(k, d) { try { const v = GM_getValue(k); return (v === undefined || v === null) ? d : v; } catch (e) { return d; } }
    function gmSet(k, v) { try { GM_setValue(k, v); } catch (e) {} }
    function isRunning() { return String(gmGet(K_RUNNING, '0')) === '1'; }
    function setRunning(v) { running = !!v; gmSet(K_RUNNING, running ? '1' : '0'); renderToggleBtn(); }
    function paused() { return !running; }

    function haltIfPaused(resumeFn) {
        if (!running) { resumeAction = resumeFn; updateStatus('⏸ 已暂停。点击「开始」从当前步骤继续。', '#ff5000'); return true; }
        return false;
    }

    // ==================== 🐢 拟人化基础工具 ====================
    function rand(min, max) { return Math.random() * (max - min) + min; }
    function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // 随机等待（HUMAN_MODE 关闭时几乎不等，即极速模式）
    async function humanWait(min, max, label) {
        const ms = HUMAN_MODE ? randInt(min, max) : Math.min(min, 120);
        if (label) updateStatus(label + '（随机等待 ' + (ms / 1000).toFixed(1) + ' 秒）', 'blue');
        await sleep(ms);
        return ms;
    }
    // 拟人点击：滚动到可见 → 鼠标移动轨迹 → 按下/抬起 → 原生 click
    function humanClick(el) {
        if (!el) return;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
        let cx = 0, cy = 0;
        try { const r = el.getBoundingClientRect(); cx = r.left + r.width / 2 + rand(-3, 3); cy = r.top + r.height / 2 + rand(-2, 2); } catch (e) {}
        const opt = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        try {
            el.dispatchEvent(new MouseEvent('mouseover', opt));
            el.dispatchEvent(new MouseEvent('mousemove', opt));
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: cx + rand(-4, 4), clientY: cy + rand(-3, 3) }));
            el.dispatchEvent(new MouseEvent('mousedown', opt));
            if (el.focus) el.focus();
            el.dispatchEvent(new MouseEvent('mouseup', opt));
        } catch (e) {}
        try { el.click(); } catch (e) { try { el.dispatchEvent(new MouseEvent('click', opt)); } catch (e2) {} }
    }
    function setNativeValue(el, value) {
        try {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        } catch (e) { try { el.value = value; } catch (e2) {} }
    }
    // 天猫富文本兜底：.J_textInput 运行时可能被升级成 shadow DOM 编辑器
    function syncShadow(el, value) {
        try {
            if (el && el.shadowRoot) {
                let inner = el.shadowRoot.querySelector('#textEditor, [contenteditable="true"], #textEl');
                if (inner && inner.shadowRoot) inner = inner.shadowRoot.querySelector('#textEl, [contenteditable="true"]') || inner;
                if (inner) {
                    inner.focus();
                    if ('value' in inner) { try { Object.getOwnPropertyDescriptor(inner.constructor.prototype, 'value').set.call(inner, value); } catch (e) { inner.value = value; } }
                    else inner.textContent = value;
                    inner.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        } catch (e) {}
    }
    // 拟人逐字输入
    async function humanType(el, text) {
        if (!el) return;
        text = String(text == null ? '' : text);
        const maxLen = parseInt(el.getAttribute && el.getAttribute('maxlength'), 10);
        if (maxLen > 0 && text.length > maxLen) text = text.slice(0, maxLen);
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        humanClick(el);                       // 像真人先点一下输入框聚焦
        await sleep(HUMAN_MODE ? randInt(150, 500) : 5);
        setNativeValue(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); // 清空
        if (!HUMAN_MODE) {                    // 极速模式（HUMAN_MODE=false）：一次性写入
            setNativeValue(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            syncShadow(el, text);
            return;
        }
        let typed = '';
        for (let i = 0; i < text.length; i++) {
            typed += text.charAt(i);
            setNativeValue(el, typed);
            try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: text.charAt(i) })); } catch (e) {}
            el.dispatchEvent(new Event('input', { bubbles: true }));
            try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.charAt(i) })); } catch (e) {}
            let d = randInt(TYPE_MIN_MS, TYPE_MAX_MS);
            if ((i + 1) % TYPE_PAUSE_EVERY === 0) d += randInt(150, TYPE_PAUSE_MS); // 偶发“思考”停顿
            await sleep(d);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // 兜底：确保值确实写入（个别受控组件/富文本）
        if (el.value !== text) {
            try { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); } catch (e) {}
            setNativeValue(el, text); el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        syncShadow(el, text);
    }
    // 可被“暂停”打断的长睡眠（每秒查一次 running，并显示剩余时间）
    async function interruptibleSleep(ms, label) {
        const start = Date.now();
        while (running && (Date.now() - start) < ms) {
            const left = ms - (Date.now() - start);
            if (label) updateStatus(label + '（剩余 ' + Math.ceil(left / 1000) + ' 秒，可随时暂停）', '#ff5000');
            await sleep(Math.min(1500, left));
        }
    }
    // 随机滚动“浏览”页面，制造真人轨迹（最后回到顶部，操作时元素会各自 scrollIntoView）
    async function humanBrowse(times) {
        if (!HUMAN_MODE || !BROWSE_SCROLL) return;
        times = times || randInt(2, 4);
        for (let i = 0; i < times; i++) {
            const dy = randInt(120, 420) * (Math.random() < 0.22 ? -1 : 1); // 偶尔往上滚
            try { window.scrollBy({ top: dy, behavior: 'smooth' }); } catch (e) { try { window.scrollBy(0, dy); } catch (e2) {} }
            await sleep(randInt(500, 1400));
        }
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { try { window.scrollTo(0, 0); } catch (e2) {} }
        await sleep(randInt(300, 900));
    }
    // 验证码 / 风控检测：命中则暂停，等用户手动过验证，避免硬撞越撞越多
    function detectCaptcha() {
        try {
            if (/punish|captcha|_____tmd_____|x5sec|sec\.taobao|login\./i.test(location.href)) return true;
            const kw = /滑动验证|拖动.{0,4}滑块|验证码|安全验证|请完成.{0,6}验证|点击完成验证|亲，请?完成|nocaptcha|baxia|captcha/i;
            let bodyText = ''; try { bodyText = (document.body.innerText || '').slice(0, 3000); } catch (e) {}
            if (kw.test(bodyText)) return true;
            if (qs('#baxia-dialog, .baxia-dialog, [class*="nocaptcha"], [id*="nc_1_n"], [class*="J_MIDDLEWARE_FRAME"], iframe[src*="punish"], iframe[src*="captcha"], #nocaptcha, .nc-container')) return true;
        } catch (e) {}
        return false;
    }
    function haltOnCaptcha() {
        if (detectCaptcha()) {
            setRunning(false);
            updateStatus('🛑 检测到验证码/风控，已自动暂停。请手动完成验证后，再点「开始」继续（硬闯只会触发更多验证）。', 'red');
            return true;
        }
        return false;
    }

    // ==================== 迷你 DOM 工具（原生实现，无任何第三方依赖） ====================
    function qa(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
    function qs(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
    function visible(el) { if (!el) return false; return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
    function visArr(sel, root) { return qa(sel, root).filter(visible); }
    function txt(el) { return (el && (el.value || el.textContent) || '').trim(); }

    function clickableByText(text, contains, tags) {
        tags = tags || 'a, button, span, div, input, label';
        return qa(tags).filter(visible).filter(function (el) {
            let t;
            if (el.tagName === 'INPUT') t = (el.value || '');
            else { const c = el.cloneNode(true); Array.prototype.slice.call(c.children).forEach(function (x) { x.remove(); }); t = (c.textContent || ''); }
            t = t.trim();
            return contains ? t.indexOf(text) !== -1 : t === text;
        });
    }
    function forceSameTabNav(el) {
        let node = el;
        while (node && node !== document.body) { const tag = node.tagName; if (tag === 'A' || tag === 'FORM') node.setAttribute('target', '_self'); node = node.parentNode; }
    }
    function withOpenGuard(fn) {
        const orig = W.open; let restored = false;
        const restore = function () { if (restored) return; restored = true; try { W.open = orig; } catch (e) {} };
        try { W.open = function (url) { try { if (url) location.href = url; } catch (e) {} return null; }; } catch (e) {}
        try { fn(); } finally { restore(); setTimeout(restore, 500); }
    }

    // 倒计时后自动点击（delay 可为数字或 [min,max] 随机区间；点击用拟人 humanClick）
    function autoClickAfter(getEl, label, delay, onNotFound, preClick) {
        let ms;
        if (Array.isArray(delay)) ms = HUMAN_MODE ? randInt(delay[0], delay[1]) : Math.max(150, delay[0]);
        else if (delay == null) ms = HUMAN_MODE ? randInt(Math.round(AUTO_CLICK_DELAY * 0.6), Math.round(AUTO_CLICK_DELAY * 1.7)) : AUTO_CLICK_DELAY;
        else ms = delay;
        let remain = Math.ceil(ms / 1000);
        if (remain > 0) updateStatus(label + '：' + remain + '秒后自动点击...', 'blue');
        const timer = setInterval(function () { remain--; if (remain > 0) updateStatus(label + '：' + remain + '秒后自动点击...', 'blue'); }, 1000);
        setTimeout(function () {
            clearInterval(timer);
            if (haltIfPaused(function () { autoClickAfter(getEl, label, 0, onNotFound, preClick); })) return;
            const el = getEl();
            if (el) {
                if (preClick && preClick(el) === false) { updateStatus(label + '：已被守卫规则取消。', '#ff5000'); return; }
                updateStatus(label + '：已自动点击 ✅', 'green');
                try { forceSameTabNav(el); withOpenGuard(function () { humanClick(el); }); } catch (e) { try { humanClick(el); } catch (e2) {} }
            } else { updateStatus(label + '：未找到目标元素，流程已停止。', 'red'); if (onNotFound) onNotFound(); }
        }, ms);
    }

    // ==================== 控制面板 UI ====================
    function createUI() {
        if (document.getElementById('tb-ai-review-ui')) return;
        const box = document.createElement('div');
        box.id = 'tb-ai-review-ui';
        box.style.cssText = "position:fixed;top:30%;right:20px;width:262px;background:#fff;border:2px solid #ff5000;border-radius:8px;padding:15px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.15);font-family:'Microsoft YaHei',sans-serif;";
        box.innerHTML =
            '<h3 style="margin:0 0 12px;font-size:15px;color:#ff5000;text-align:center;border-bottom:1px solid #eee;padding-bottom:10px;">🤖 淘宝/天猫 AI 自动评价</h3>' +
            '<button id="tb-ai-btn-toggle" style="width:100%;padding:10px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;margin-bottom:10px;">开始</button>' +
            '<div id="tb-ai-status" style="font-size:12px;color:#666;min-height:44px;background:#f8f8f8;padding:8px;border-radius:4px;word-wrap:break-word;line-height:1.5;">状态：等待页面加载...</div>';
        document.body.appendChild(box);
        document.getElementById('tb-ai-btn-toggle').addEventListener('click', function () {
            if (running) { setRunning(false); updateStatus('⏸ 暂停中…当前步骤完成后停止。', '#ff5000'); }
            else {
                if (!checkConfig()) return;
                gmSet(K_ATTEMPTS, '{}');
                setRunning(true);
                // 在“已买到的宝贝”订单页：若当前不在“待评价”标签，先跳过去再开始（跳转后该页会自动续跑）
                if (PLATFORM === 'list' && !isWaitRate()) {
                    updateStatus('▶ 跳转到「待评价」页面并开始...', 'blue');
                    location.href = WAITRATE_URL; return;
                }
                updateStatus('▶ 继续执行...', 'blue');
                const fn = resumeAction || currentStep; resumeAction = null; if (fn) fn();
            }
        });
        renderToggleBtn();
    }
    function renderToggleBtn() {
        const b = document.getElementById('tb-ai-btn-toggle'); if (!b) return;
        if (running) { b.textContent = '暂停'; b.style.background = '#f0ad4e'; }
        else { b.textContent = (PLATFORM === 'list' ? '开始评价' : '开始'); b.style.background = '#28a745'; }
    }
    function updateStatus(text, color) {
        const el = document.getElementById('tb-ai-status');
        if (el) { el.textContent = '状态：' + text; el.style.color = color || '#666'; }
        console.log('[TB AI Review]', text);
    }
    function checkConfig() {
        if (!API_KEY || API_KEY.trim() === '' || API_KEY.indexOf('sk-') !== 0) { updateStatus('❌ 错误：请先在脚本顶部配置有效的 API_KEY！', 'red'); return false; }
        return true;
    }

    // ==================== 大模型 API（GM_xmlhttpRequest，绕过浏览器跨域限制） ====================
    function buildPrompt(productName, kind) {
        if (kind === 'service') {
            return '你是一名真实的淘宝/天猫买家。请为这次购物写一段约' + SERVICE_LEN + '字的「服务评价」，可涉及卖家沟通、发货、包装、售后等，但要具体、口语化、像真人写的，避免空泛模板。字数不超过90字。直接输出纯文本正文，不要任何前缀或引号。';
        }
        return '你是一名真实的淘宝/天猫买家，刚收到商品。商品全称是:【' + productName + '】。\n\n' +
            '请写一段约' + REVIEW_LEN + '字的商品好评，严格遵守：\n' +
            '1. 根据名称推断它具体是什么（如抽纸、数据线、碗），只评价它该有的特定属性（如抽纸评价韧性/厚度/是否掉屑/湿水是否易破）。\n' +
            '2. 禁止“物流快”“客服好”“包装严实”“下次还来”等万能废话。\n' +
            '3. 不要抄商品全名，用“这款”“这个”代替。\n' +
            '4. 口语化、像真人随手写，字数不少于' + REVIEW_LEN + '字。\n' +
            '5. 直接输出纯文本正文，不要任何前缀、引号或提示语。';
    }
    function generateReview(productName, kind, onOk, onErr) {
        GM_xmlhttpRequest({
            method: 'POST', url: API_URL,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
            data: JSON.stringify({ model: MODEL_NAME, messages: [{ role: 'system', content: buildPrompt(productName, kind) }], temperature: 0.9 }),
            timeout: 30000,
            onload: function (response) {
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.error) { onErr(result.error.message || result.error.code || 'API 拒绝请求'); return; }
                    const review = (result.choices && result.choices[0] && result.choices[0].message) ? result.choices[0].message.content : '';
                    if (review && review.trim().length > 5) onOk(review.trim().replace(/^["'“”\s]+|["'“”\s]+$/g, ''));
                    else onErr('返回内容过短或为空');
                } catch (e) { onErr('解析响应失败：' + String(response.responseText).slice(0, 120)); }
            },
            onerror: function () { onErr('请求网络错误'); },
            ontimeout: function () { onErr('请求超时'); }
        });
    }
    // Promise 包装，便于 async/await
    function aiReview(name, kind) { return new Promise(function (res, rej) { generateReview(name, kind, res, rej); }); }

    // ==================== 自动配图（商品主图，按分辨率过滤图标；异常即跳过、不阻断闭环） ====================
    function uniq(a) { const s = {}, o = []; a.forEach(function (x) { if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
    function normalizeImgUrl(u) {
        if (!u) return ''; u = String(u).trim();
        if (u.indexOf('//') === 0) u = 'https:' + u;
        if (u.indexOf('http') !== 0) return '';
        u = u.replace(/(\.(?:jpg|jpeg|png))_.*$/i, '$1').replace(/_sum\.(jpg|jpeg|png)$/i, '.$1').replace(/\.webp$/i, '.jpg');
        return u;
    }
    function isProductImg(u) { return /alicdn\.com|taobaocdn\.com/.test(u) && !/(icon|logo|avatar|head|\/\/gtms|spacer|blank|\/TB1[a-z0-9]*_!!0)/i.test(u); }
    function urlDim(u) { const m = /tps-(\d+)-(\d+)/i.exec(u) || /-(\d{2,4})-(\d{2,4})\.(?:jpg|jpeg|png)/i.exec(u); return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null; }
    function passDimFilter(u) { const d = urlDim(u); if (d && Math.min(d[0], d[1]) < MIN_IMAGE_DIM) return false; return true; }

    function fetchItemDetailImages(itemId) {
        return new Promise(function (resolve) {
            if (!itemId) { resolve([]); return; }
            GM_xmlhttpRequest({ method: 'GET', url: 'https://item.taobao.com/item.htm?id=' + itemId, timeout: 12000, onload: function (r) { resolve(extractImgs(r.responseText)); }, onerror: function () { resolve([]); }, ontimeout: function () { resolve([]); } });
        });
    }
    function fetchTradeSnapImages(tradeId) {
        return new Promise(function (resolve) {
            if (!tradeId) { resolve({ images: [], itemId: '' }); return; }
            GM_xmlhttpRequest({
                method: 'GET', url: 'https://trade.taobao.com/trade/detail/trade_snap.htm?trade_id=' + tradeId, timeout: 12000,
                onload: function (r) {
                    let html = ''; try { html = (r.responseText || '').replace(/\\\//g, '/'); } catch (e) {}
                    let itemId = '';
                    const mi = html.match(/item\.htm\?[^"'\s]*?id=(\d{6,})/) || html.match(/auctionNumId["':=\s]+(\d{6,})/) || html.match(/itemId["':=\s]+(\d{6,})/);
                    if (mi) itemId = mi[1];
                    resolve({ images: extractImgs(html), itemId: itemId });
                },
                onerror: function () { resolve({ images: [], itemId: '' }); }, ontimeout: function () { resolve({ images: [], itemId: '' }); }
            });
        });
    }
    function extractImgs(html) {
        let urls = [];
        try {
            html = (html || '').replace(/\\\//g, '/');
            const re = /(?:https?:)?\/\/[a-z0-9.]*alicdn\.com\/[^"'\s<>\\]+?\.(?:jpg|jpeg|png)/gi; let m;
            while ((m = re.exec(html)) !== null) { const u = normalizeImgUrl(m[0]); if (isProductImg(u)) urls.push(u); }
        } catch (e) {}
        return uniq(urls);
    }
    function fetchImageBlob(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({ method: 'GET', url: url, responseType: 'blob', timeout: 15000, onload: function (r) { (r.status >= 200 && r.status < 300 && r.response) ? resolve(r.response) : reject('HTTP ' + r.status); }, onerror: function () { reject('网络错误'); }, ontimeout: function () { reject('超时'); } });
        });
    }
    // 重编码为真 JPEG，自适应压到 maxKB 以内；并按真实像素剔除小图/图标
    function blobToJpegFile(blob, name, maxKB) {
        maxKB = maxKB || 5000;
        return new Promise(function (resolve, reject) {
            const objUrl = URL.createObjectURL(blob); const img = new Image();
            img.onload = function () {
                URL.revokeObjectURL(objUrl);
                const nw = img.naturalWidth, nh = img.naturalHeight;
                if (!nw || !nh) { reject('图片尺寸为0'); return; }
                if (Math.min(nw, nh) < MIN_IMAGE_DIM) { reject('图片过小疑似图标 ' + nw + 'x' + nh); return; }
                const attempts = [[1600, 0.88], [1280, 0.82], [1000, 0.75], [800, 0.65], [640, 0.55], [520, 0.5]];
                let i = 0;
                const step = function () {
                    if (i >= attempts.length) { reject('压不到目标体积'); return; }
                    const MAX = attempts[i][0], q = attempts[i][1]; i++;
                    let w = img.naturalWidth, h = img.naturalHeight;
                    if (Math.max(w, h) > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
                    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
                    cv.toBlob(function (jpg) {
                        if (!jpg) { reject('toBlob失败'); return; }
                        if (jpg.size <= maxKB * 1024 || i >= attempts.length) resolve(new File([jpg], name, { type: 'image/jpeg' }));
                        else step();
                    }, 'image/jpeg', q);
                };
                step();
            };
            img.onerror = function () { URL.revokeObjectURL(objUrl); reject('图片解码失败'); };
            img.src = objUrl;
        });
    }
    function injectFiles(input, files) { const dt = new DataTransfer(); files.forEach(function (f) { dt.items.add(f); }); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
    function findFileInput() {
        return qs('.J_photo_uploader input.file-input') || qs('input.file-input[name="Filedata"]') ||
            qs('#J_Uploader170Btn') || qs('input.file-input') || qs('input[type="file"][name="picture"]') ||
            qa('input[type="file"]').filter(function (i) { const a = i.getAttribute('accept') || ''; return a === '' || /image/i.test(a); })[0] || null;
    }
    function detectMaxImages() {
        let max = 0; const fi = findFileInput();
        if (fi) { const v = parseInt(fi.getAttribute('max'), 10); if (v > 0) max = v; }
        if (!max) { const b = qs('.J_photo_uploader [data-auth], .upload-btn[data-auth], .J_btn[data-auth]'); if (b) { try { const a = JSON.parse(b.getAttribute('data-auth')); if (a && a.max && a.max[0]) max = parseInt(a.max[0], 10); } catch (e) {} } }
        if (!max) { const t = qs('.up-tips .tot'); if (t) { const v = parseInt(t.textContent, 10); if (v > 0) max = v; } }
        if (!max) max = 5;
        return Math.min(IMG_PER_PRODUCT, max);
    }
    function detectMaxSizeKB() {
        const fi = findFileInput();
        if (fi) { const v = parseInt(fi.getAttribute('maxsize'), 10); if (v > 0) return v; }
        const b = qs('.J_photo_uploader [data-auth], .upload-btn[data-auth]');
        if (b) { try { const a = JSON.parse(b.getAttribute('data-auth')); if (a && a.maxSize && a.maxSize[0]) return parseInt(a.maxSize[0], 10); } catch (e) {} }
        return 5000;
    }
    function waitUploads(min, timeout) {
        return new Promise(function (resolve) {
            const start = Date.now();
            const iv = setInterval(function () {
                const n = qa('.upload-queue li, .J_queue li, [id$="Queue"] li').filter(visible).length;
                const hid = qs('input[type="hidden"][name^="pictures"], input[type="hidden"][name="urls"]');
                const filled = !!(hid && hid.value && hid.value.trim().length > 0);
                if (n >= min || filled || (Date.now() - start) > timeout) { clearInterval(iv); resolve(Math.max(n, filled ? min : 0)); }
            }, 600);
        });
    }
    async function uploadImagesThenSubmit() {
        if (haltIfPaused(uploadImagesThenSubmit)) return;
        const input = findFileInput();
        if (!input) { updateStatus('未找到图片上传入口，跳过配图直接提交。', '#ff5000'); submitStep(); return; }
        const maxN = detectMaxImages(), maxKB = detectMaxSizeKB();
        const tradeId = getTradeId();
        updateStatus('配图：抓取商品主图（上限' + maxN + '张/' + maxKB + 'KB/最短边≥' + MIN_IMAGE_DIM + 'px）...', 'blue');
        let urls = [];
        try {
            const snap = await fetchTradeSnapImages(tradeId);
            let detail = [];
            if (snap.itemId) detail = await fetchItemDetailImages(snap.itemId);
            urls = uniq(detail.concat(snap.images)).filter(isProductImg).filter(passDimFilter);
        } catch (e) { urls = []; }
        if (!urls.length) { updateStatus('未抓到符合尺寸的商品图，跳过配图直接提交。', '#ff5000'); submitStep(); return; }
        const cand = urls.slice(0, Math.max(maxN * 3, maxN));
        const files = (await Promise.all(cand.map(function (u, i) {
            return fetchImageBlob(u).then(function (b) { return blobToJpegFile(b, 'rate_' + i + '.jpg', maxKB); }).catch(function () { return null; });
        }))).filter(Boolean).slice(0, maxN);
        if (!files.length) { updateStatus('图片下载/转码失败或均过小，跳过配图直接提交。', '#ff5000'); submitStep(); return; }
        await humanWait(500, 1500, '挑选好图片，准备上传');
        injectFiles(input, files);
        updateStatus('已注入 ' + files.length + ' 张商品图，等待上传完成...', 'green');
        await waitUploads(files.length, UPLOAD_WAIT_TIMEOUT);
        await humanWait(600, 1600, '图片上传完成');
        submitStep();
    }

    // ==================== 平台相关：星级 / 公开 / 提交 / 商品名 / 订单号 ====================
    async function setStarsHuman() {
        const gap = function () { return sleep(HUMAN_MODE ? randInt(180, 560) : 5); };
        if (PLATFORM === 'tmall') {
            const stars = qa('.J_ratingStar[data-star-value="5"], .tm-rating-star-list [data-star-value="5"]');
            for (let i = 0; i < stars.length; i++) { humanClick(stars[i]); await gap(); }
            qa('input.J_ratingLevel').forEach(function (h) { try { h.value = '5'; h.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} });
        } else {
            const goods = qa('.good-rate');
            for (let i = 0; i < goods.length; i++) { humanClick(goods[i]); await gap(); }
            const dims = ['description', 'attitude', 'delivery'];
            for (let i = 0; i < dims.length; i++) { const f = qs('input[type="radio"][name="' + dims[i] + '"][value="5"]'); if (f) { humanClick(f); await gap(); } }
            const spans = qa('.rate-stars');
            for (let i = 0; i < spans.length; i++) { const l = spans[i].querySelectorAll('label'); if (l.length >= 5) { humanClick(l[4].querySelector('input') || l[4]); await gap(); } }
        }
    }
    function setPublic() {
        if (!SET_PUBLIC) return;
        try {
            if (PLATFORM === 'tmall') {
                const a = qs('input.rate-anony[name="anony"], input[name="anony"][type="checkbox"]');
                if (a && a.checked) { humanClick(a); if (a.checked) a.checked = false; } // 取消匿名=公开
            } else {
                const pub = qs('input[type="radio"][name^="anony"][value="0"]') || qs('[id^="privacy-radio-public"]');
                if (pub && !pub.disabled && !pub.checked) humanClick(pub);
            }
        } catch (e) {}
    }
    function findSubmitBtn() {
        if (PLATFORM === 'tmall') {
            return qs('#RateWriteForm .compose-btn button[type="submit"]') || qs('.compose-btn button[type="submit"]') || qa('#RateWriteForm button[type="submit"]')[0] || null;
        }
        return qs('.J_submit_rate') || qs('.submitbox button[type="submit"]') || qs('#rateListForm button[type="submit"]') || null;
    }
    function getProductName() {
        if (PLATFORM === 'tmall') {
            const h = qs('.ui-form-label h3') || qs('h3');
            if (h && txt(h)) return txt(h);
            const t = (document.title || '').replace(/-.*(天猫|淘宝).*$/, '').trim();
            return t || '天猫商品';
        }
        const a = qs('.item-title a');
        return (a && txt(a)) || '淘宝商品';
    }
    function getTradeId() {
        try { const t = new URLSearchParams(location.search).get('tradeID'); if (t) return t; } catch (e) {}
        const ta = qs('textarea[name^="rateContents"], textarea[name^="qualityContent"]');
        if (ta) { const m = (ta.getAttribute('name') || '').match(/(\d{6,})/); if (m) return m[1]; }
        const m2 = location.href.match(/tradeID=(\d+)/) || location.href.match(/(\d{16,})/);
        return m2 ? m2[1] : '';
    }
    function rememberListUrlFromRate() {
        try {
            let ru = new URLSearchParams(location.search).get('returnURL') || '';
            if (ru.indexOf('%') !== -1) { try { ru = decodeURIComponent(ru); } catch (e) {} }
            if (/^https?:\/\/[^/]*taobao\.com/.test(ru)) saveListUrl(ru);
        } catch (e) {}
    }
    function saveListUrl(url) {
        if (!url) return;
        if (url.indexOf('tabCode=') === -1) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'tabCode=waitRate';
        gmSet(K_LISTURL, url);
    }
    function isWaitRate() { return /[?&]tabCode=waitRate/.test(location.href) || /%3DwaitRate/i.test(location.href); }
    function bumpAttempt(tradeId) {
        let map = {}; try { map = JSON.parse(gmGet(K_ATTEMPTS, '{}')) || {}; } catch (e) { map = {}; }
        const c = (map[tradeId] || 0) + 1; if (tradeId) { map[tradeId] = c; gmSet(K_ATTEMPTS, JSON.stringify(map)); } return c;
    }

    // ==================== 评价页主流程（拟人化：浏览→满星→公开→逐字输入→配图→提交） ====================
    async function startReviewProcess() {
        if (!checkConfig()) return;
        rememberListUrlFromRate();
        if (haltOnCaptcha()) return; // 有验证码就暂停，等人工过

        const inputs = (PLATFORM === 'tmall')
            ? { item: qs('.J_rateItem, textarea[name^="qualityContent"]'), service: qs('.J_rateService, textarea[name^="serviceContent"]') }
            : { list: findTaobaoMsgInputs() };
        const hasInput = (PLATFORM === 'tmall') ? !!inputs.item : (inputs.list && inputs.list.length > 0);
        if (!hasInput) { handleNoInputPage(); return; }

        const tradeId = getTradeId();
        const tries = bumpAttempt(tradeId);
        if (tries > MAX_SUBMIT_TRY) {
            setRunning(false);
            updateStatus('⚠ 订单 ' + (tradeId || '?') + ' 已连续提交 ' + (tries - 1) + ' 次未成功（可能验证码/风控），已暂停。请手动处理后点「开始」。', 'red');
            return;
        }

        // 像真人一样，进页面先“看一会儿”
        await humanWait(READ_MIN_MS, READ_MAX_MS, '进入评价页，先浏览一下');
        if (paused()) { resumeAction = startReviewProcess; return; }
        await humanBrowse(randInt(1, 3)); // 随机滚动浏览商品/评价区，制造真人轨迹
        if (paused()) { resumeAction = startReviewProcess; return; }

        await setStarsHuman();                 // 好评/满星（每颗星之间有随机停顿）
        if (paused()) { resumeAction = startReviewProcess; return; }
        await humanWait(350, 1000);
        setPublic();                           // 设为公开
        await humanWait(350, 1000);

        const name = getProductName();
        const shortName = name.length > 15 ? name.slice(0, 15) + '...' : name;

        if (PLATFORM === 'tmall') {
            updateStatus('天猫单：生成宝贝评价 + 服务评价（' + shortName + '）', 'blue');
            let rev;
            try { rev = await aiReview(name, 'product'); } catch (err) { onAiError(err); return; }
            if (paused()) { resumeAction = startReviewProcess; return; }
            await humanWait(500, 1400, '宝贝评价已生成，准备逐字输入');
            await humanType(inputs.item, rev);
            await humanWait(STEP_MIN_MS, STEP_MAX_MS, '宝贝评价输入完成');
            if (inputs.service) {
                try {
                    const srv = await aiReview(name, 'service');
                    await humanWait(400, 1100, '服务评价已生成，准备逐字输入');
                    await humanType(inputs.service, srv);
                } catch (e) { /* 服务评价失败也继续 */ }
            }
        } else {
            const names = qa('.item-title a');
            updateStatus('淘宝单：' + inputs.list.length + ' 个评价框（' + shortName + '）', 'blue');
            for (let i = 0; i < inputs.list.length; i++) {
                if (paused()) { resumeAction = startReviewProcess; return; }
                let nm = (names[i] && txt(names[i])) || (names[0] && txt(names[0])) || '淘宝商品';
                nm = nm.length > 40 ? nm.slice(0, 40) : nm;
                updateStatus('正在生成 ' + (i + 1) + '/' + inputs.list.length + '：' + (nm.length > 15 ? nm.slice(0, 15) + '...' : nm), 'blue');
                let rev;
                try { rev = await aiReview(nm, 'product'); }
                catch (err) { setRunning(false); resumeAction = startReviewProcess; updateStatus('❌ 第 ' + (i + 1) + ' 个评语生成失败：' + err + '。已暂停，点「开始」重试。', 'red'); return; }
                if (paused()) { resumeAction = startReviewProcess; return; }
                await humanWait(400, 1100);
                await humanType(inputs.list[i], rev);
                await humanWait(STEP_MIN_MS, STEP_MAX_MS);
            }
        }
        if (paused()) { resumeAction = startReviewProcess; return; }
        afterTextFilled();
    }

    function afterTextFilled() {
        updateStatus('✅ 评语已生成、满星、设为公开' + (ENABLE_IMAGE ? '，开始自动配图...' : '，准备提交...'), 'green');
        if (ENABLE_IMAGE) uploadImagesThenSubmit(); else submitStep();
    }
    function onAiError(err) {
        setRunning(false); resumeAction = startReviewProcess;
        updateStatus('❌ 评语生成失败：' + err + '。已暂停，排查后点「开始」重试。', 'red');
    }
    function handleNoInputPage() {
        let bodyText = ''; try { bodyText = document.body.innerText || ''; } catch (e) {}
        const listUrl = gmGet(K_LISTURL, DEFAULT_LIST_URL);
        if (/成功|感谢您的评价|评价已完成|已评价/.test(bodyText) || /remarkSeller4C|rateWriteResult|success/i.test(location.href)) {
            updateStatus('✅ 评价已提交，返回待评价列表...', 'green');
            setTimeout(function () { location.href = listUrl; }, HUMAN_MODE ? randInt(1200, 2800) : 300); return;
        }
        updateStatus('未检测到评价输入框（当前页可能不是评价页）。', 'red'); setRunning(false);
    }
    function findTaobaoMsgInputs() {
        let arr = qa('textarea.rate-msg');
        if (!arr.length) arr = qa('textarea[name^="rateContents"]');
        if (!arr.length) arr = qa('.rate-msg');
        if (!arr.length) arr = qa('textarea');
        return arr;
    }

    async function submitStep() {
        if (haltIfPaused(submitStep)) return;
        const btn = findSubmitBtn();
        if (!btn) { updateStatus('未找到提交按钮，请手动检查页面。', 'red'); setRunning(false); return; }
        await humanWait(CLICK_MIN_MS + 700, CLICK_MAX_MS + 1800, '检查内容无误，准备提交'); // 像真人提交前再看一眼
        if (haltIfPaused(submitStep)) return;
        updateStatus('正在提交评价...', 'blue');
        try { forceSameTabNav(btn); withOpenGuard(function () { humanClick(btn); }); } catch (e) { try { humanClick(btn); } catch (e2) {} }
        afterSubmitReturn();
    }
    function afterSubmitReturn() {
        const listUrl = gmGet(K_LISTURL, DEFAULT_LIST_URL);
        const onRateHost = /^(rate\.taobao\.com|ratewrite\.tmall\.com)$/.test(location.host);
        let waited = 0, navigated = false;
        const maxWait = HUMAN_MODE ? randInt(5000, 9000) : 3000;
        updateStatus('已提交，等待返回待评价列表...', 'blue');
        const iv = setInterval(function () {
            waited += 1000;
            let bodyText = ''; try { bodyText = document.body.innerText || ''; } catch (e) {}
            const left = !/^(rate\.taobao\.com|ratewrite\.tmall\.com)$/.test(location.host);
            const success = /评价成功|发布成功|提交成功|感谢您的评价/.test(bodyText) || left;
            if (success || waited >= maxWait) {
                clearInterval(iv);
                if (!navigated && !left && onRateHost) {
                    navigated = true; updateStatus('返回待评价列表，处理下一单...', 'blue');
                    setTimeout(function () { location.href = listUrl; }, HUMAN_MODE ? randInt(800, 2200) : 200);
                }
            }
        }, 1000);
    }

    // ==================== 列表页主流程（已买到的宝贝，React 渲染） ====================
    function findFirstRateLink() {
        const ops = qa('.tbpc_boughtlist_orderItem_order_op, [class*="orderItem_order_op"]');
        for (let i = 0; i < ops.length; i++) { const t = txt(ops[i]); if ((t === '评价' || t === '去评价') && !/追加|查看|已评价/.test(t)) return ops[i]; }
        const as = qa('a').filter(visible);
        let hit = as.filter(function (a) { return /remarkSeller|rate_detail|ratewrite\.tmall\.com/i.test(a.getAttribute('href') || ''); });
        if (hit.length) return hit[0];
        hit = as.filter(function (a) { const h = a.getAttribute('href') || ''; return /rate\.taobao\.com/.test(h) && !/(view_rate|rate_detail|myRate|my_rate)/i.test(h); });
        if (hit.length) return hit[0];
        const btns = clickableByText('去评价', false).concat(clickableByText('评价', false));
        for (let i = 0; i < btns.length; i++) { const t = txt(btns[i]); if (!/追加|查看|已评价|管理/.test(t)) return btns[i]; }
        return null;
    }
    async function runListStep() {
        saveListUrl(location.href);
        if (haltOnCaptcha()) return;                 // 有验证码就暂停，等人工过
        await humanBrowse(randInt(1, 3));            // 像真人先在列表里“扫一眼”
        if (paused()) { resumeAction = runListStep; return; }
        // 先确认还有下一单，没有就直接结束（不浪费长休息）
        if (!findFirstRateLink()) { setRunning(false); updateStatus('🎉 待评价列表已空（无更多「评价」入口），循环结束。', 'green'); return; }
        // 连续评价若干单后，长休息一会儿（防风控核心）
        let count = parseInt(gmGet(K_ORDER_COUNT, '0'), 10) || 0;
        let nextBreak = parseInt(gmGet(K_NEXT_BREAK, '0'), 10) || 0;
        if (!nextBreak) { nextBreak = randInt(BREAK_EVERY_MIN, BREAK_EVERY_MAX); gmSet(K_NEXT_BREAK, String(nextBreak)); }
        if (count > 0 && count >= nextBreak) {
            const brk = randInt(BREAK_MIN_MS, BREAK_MAX_MS);
            await interruptibleSleep(brk, '😴 已连续评价 ' + count + ' 单，像真人一样休息 ' + Math.round(brk / 1000) + ' 秒防风控');
            if (paused()) { resumeAction = runListStep; return; }
            count = 0; gmSet(K_ORDER_COUNT, '0'); gmSet(K_NEXT_BREAK, String(randInt(BREAK_EVERY_MIN, BREAK_EVERY_MAX)));
        }
        gmSet(K_ORDER_COUNT, String(count + 1));     // 本单计数
        autoClickAfter(findFirstRateLink, '进入下一单评价', [ORDER_MIN_MS, ORDER_MAX_MS],
            function () { setRunning(false); updateStatus('🎉 待评价列表已空（无更多「评价」入口），循环结束。', 'green'); },
            function (el) { updateStatus('进入评价：' + (txt(el) || '评价'), 'blue'); return true; }
        );
    }

    // ==================== 页面分发 ====================
    function boot() {
        createUI(); running = isRunning(); renderToggleBtn();
        if (PLATFORM === 'list') currentStep = runListStep;
        else if (PLATFORM === 'taobao' || PLATFORM === 'tmall') currentStep = startReviewProcess;
        else { updateStatus('当前页面不在自动化范围内（需在待评价列表 / 淘宝评价页 / 天猫评价页）。', '#ff5000'); return; }

        if (running) {
            if (PLATFORM === 'taobao' || PLATFORM === 'tmall') {
                if (!checkConfig()) return;
                const d = HUMAN_MODE ? randInt(1600, 3800) : 400;
                updateStatus('循环中，' + (d / 1000).toFixed(1) + '秒后开始本单评价（' + PLATFORM + '）...', 'blue');
                setTimeout(function () { if (isRunning()) startReviewProcess(); }, d);
            } else if (PLATFORM === 'list') {
                if (!isWaitRate()) { updateStatus('循环中，跳转到「待评价」页面...', 'blue'); location.href = WAITRATE_URL; }
                else runListStep();
            }
        } else updateStatus('点击「' + (PLATFORM === 'list' ? '开始评价' : '开始') + '」启动全自动评价循环（拟人化：随机等待+逐字输入）。' + (PLATFORM === 'list' && !isWaitRate() ? '（将自动跳转到“待评价”页）' : ''), 'blue');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
