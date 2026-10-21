// Counts how often each company problem of src/problem-list.js is reported in 字节 interview posts on Nowcoder
// (牛客网). Run from the project directory:
//   node scripts/company-problems.mjs             counts from the posts kept in data/nowcoder/posts.json
//   node scripts/company-problems.mjs --collect   runs the searches and loads the posts first: a few thousand requests, about 20 minutes
//   node scripts/company-problems.mjs --show E2   prints the passages behind a count
// It changes nothing in the project. A post counts as a report of a problem only if
//   - its title (without one, its first line) names 字节 and no other company, and is not a compilation;
//   - its account is not one that reposts other people's reports: 6 or more posts among those collected, or a paid column;
//   - the problem is named right after a hand-coding word (手撕、手写、算法题…) and is not asked as theory.
// The counts are for reading, not for use as they are: when docs/企业手撕题.md was written, about one match in four
// turned out, on reading the passage, not to be the problem asked as code, or to repeat another post word for word.
// Nowcoder gives a search that is not logged in 60 results at most; that is why there are many searches.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { COMPANY_PROBLEMS } from '../src/problem-list.js';

const since = '2025-01-01', dir = 'data/nowcoder', file = `${dir}/posts.json`;
const PATTERNS = {
  E1: /(合并|merge).{0,12}(嵌套|多层|两个).{0,8}json|json.{0,12}(深度合并|递归合并|合并函数|做深度合并)|深度合并.{0,15}(json|对象|字典)|嵌套.{0,6}json.{0,12}合并|deep ?merge|递归合并两个/i,
  E2: /小于\s*(等于)?\s*[nk]\s*的最大的?(数|整数|值)|(比|小于|不超过)\s*(n|k|target|目标\S{0,3})\s*(小)?的?最大的?(数|整数)|组成.{0,14}小于.{0,10}最大|拼成的?(小于|不超过).{0,12}最大整数|小于等于n的最大值|小于目标的最大整数/i,
  E3: /圆环.{0,20}(回到?原点|回到?\s*0)|环.{0,50}步.{0,12}回到?\s*(0|原点|起点)|回到?原点.{0,10}(方案|走法)/,
  E4: /奇.{0,8}升.{0,8}偶.{0,8}降|奇数位.{0,10}(升序|递增).{0,14}偶数位.{0,10}(降序|递减)/,
  E5: /36\s*进制|三十六进制/,
  E6: /(数字|阿拉伯).{0,6}转.{0,4}(中文|汉字|大写)|(中文|汉字).{0,6}转.{0,4}(数字|阿拉伯)/,
  E7: /大数(相加|加法|相减|减法)|字符串相[加减]|高精度/,
  E8: /快排|快速排序|堆排|归并排序|冒泡排序|手撕.{0,6}排序|实现排序算法/,
  E9: /红包/,
  E10: /(过期时间|ttl|过期|超时).{0,10}(lru|缓存|cache)|(lru|缓存|cache).{0,16}(过期|ttl|超时淘汰)/i,
  E11: /限流器|令牌桶|漏桶|滑动窗口限流|限流组件|(手撕|实现|手写|写).{0,10}限流/,
  E12: /阻塞队列|blockingqueue|生产者.{0,4}消费者|线程安全的?队列/i,
  E13: /(线程|协程|goroutine).{0,16}(交替|轮流|交叉|按顺序|按照规定顺序|顺序|循环|依次).{0,10}(打印|输出)|交替打印|轮流打印|交叉打印|多线程打印/i,
  E14: /单例/,
  E15: /(手撕|实现|手写|写一个|写个|设计|一版).{0,12}(线程池|协程池)|(线程池|协程池).{0,6}(实现|手撕|类设计)/i,
  E16: /(智能指针|shared_ptr|unique_ptr).{0,10}(实现|手撕|手写)|(实现|手撕|手写).{0,10}(智能指针|shared_ptr|unique_ptr)/i,
  E17: /(并发|并行).{0,12}(调度|控制|限制|上限)|scheduler|requestlimi?t|最大并发|batchtask|限制并发|允许\s*\d+\s*个任务执行/i,
  E18: /promise\.?\s*(all|race|allsettled|any)|手写\s*promise|实现\s*promise(?!并发)/i,
  E19: /防抖|节流|debounce|throttle/i,
  E20: /(数组|对象).{0,6}(扁平|拍平|flat)|flatten|扁平为一维|flat（/i,
  E21: /(列表|数组|list).{0,10}转.{0,6}(树|tree)|tree.{0,6}扁平|扁平化\s*->\s*tree|树形结构.{0,4}转换|转换成树形/i,
  E22: /柯里化|curry/i,
  E23: /发布订阅|eventemitter|event ?bus/i,
  E24: /(手写|实现|手撕).{0,14}(call|bind|apply)\b|bind\s*方法|手撕\s*[:：]?\s*bind/i,
  E25: /(multi-?head|多头|self-?|自)\s*attention|注意力.{0,6}(实现|手撕|手写)|\bmha\b|手撕.{0,8}transformer|transformer.{0,10}(手撕|简化版)|multiheadattention/i,
  E26: /(手撕|实现|手写).{0,12}(softmax|交叉熵)/i,
  E27: /(手撕|实现|手写|计算).{0,8}auc\b/i,
  E28: /(手写|手撕|实现|写).{0,12}(agent ?loop|react\b|agent ?循环)|agent ?loop.{0,4}伪代码/i,
};
const BYTE = /字节|抖音|tiktok|飞书|头条|豆包|火山|剪映|番茄小说|懂车帝|bytedance|seed|trae|coze|扣子/i;
const OTHER = /小红书|百度|腾讯|阿里|美团|快手|携程|京东|拼多多|pdd|华为|网易|小米|滴滴|b站|bilibili|蚂蚁|米哈游|得物|虾皮|shopee|oppo|vivo|荣耀|大疆|微软|亚马逊|淘天|饿了么|蔚来|理想|小鹏|讯飞|商汤|旷视|大厂|汇总|合集|集合|总结|各厂|多家/i;
const MARK = /(手撕|手写|算法题?|代码题?|编程题?|coding|code|撕|笔试题?|题目?|实现|写一?个|写出)[^。？?！!\n]{0,28}$/i;
const THEORY = /原理|区别|了解|是什么|有哪些|怎么实现的|如何实现的|讲讲|说说|介绍一?下|底层|参数|为什么/;
const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const pause = ms => new Promise(r => setTimeout(r, ms));
const plain = s => String(s || '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>|<\/pre>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const posts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const save = () => { mkdirSync(dir, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(posts)); renameSync(`${file}.tmp`, file); };
async function call(url, options = {}) {
  for (let i = 0; ; i++) {
    try { return await (await fetch(url, { ...options, headers: { 'User-Agent': agent, 'Content-Type': 'application/json', Origin: 'https://www.nowcoder.com', Referer: 'https://www.nowcoder.com/' }, signal: AbortSignal.timeout(30000) })).json(); }
    catch (e) { if (i >= 2) throw e; await pause(2000 * (i + 1)); }
  }
}

if (process.argv.includes('--collect')) {
  const rounds = ['', '一面', '二面', '三面', '后端', '前端', '客户端', '测开', '算法岗', '大模型', 'Agent 开发', 'AI 应用开发', '服务端', 'C++', 'Go', 'Java', '秋招', '暑期', '日常实习'].map(w => `字节 ${w} 手撕`.replace('  ', ' '));
  const queries = [...rounds, '字节 算法题 面经', '字节 面经 代码题', '抖音 面经 手撕', 'TikTok 面经 手撕', '飞书 面经 手撕', ...[...COMPANY_PROBLEMS.values()].map(p => `字节 手撕 ${p.title.replace(/\s*\/.*$/, '')}`)];
  for (const query of queries) for (const order of ['create', '']) {
    for (let page = 1; page <= 3; page++) {
      const data = (await call('https://gw-c.nowcoder.com/api/sparta/pc/search', { method: 'POST', body: JSON.stringify({ type: 'all', query, page, tag: [], order }) })).data;
      if (!data?.records?.length) break;
      for (const r of data.records) {
        const moment = r.data?.momentData, m = moment || r.data?.contentData; if (!m) continue;
        posts[m.uuid || String(m.id)] ||= { kind: moment ? 'moment' : 'content', id: String(m.id), uuid: m.uuid, title: m.title || '', author: r.data.userBrief?.userId, at: new Date(m.createdAt || m.createTime || 0).toISOString().slice(0, 10), paid: !!r.data.blogZhuanlan?.articlePrice };
      }
      await pause(350);
    }
    console.log(`「${query}」${order ? '最新' : '最相关'}：累计 ${Object.keys(posts).length} 篇`); save();
  }
  const todo = Object.values(posts).filter(p => p.at >= since && p.full === undefined); let next = 0, done = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let p; (p = todo[next++]);) {
      const d = await call(p.kind === 'moment' ? `https://gw-c.nowcoder.com/api/sparta/detail/moment-data/detail/${p.uuid}` : `https://gw-c.nowcoder.com/api/sparta/detail/content-data/detail/${p.id}`).catch(() => ({}));
      p.full = d.success ? plain(d.data.content || d.data.richText) : ''; p.title ||= d.data?.title || '';
      if (++done % 100 === 0) { save(); console.log(`全文 ${done} / ${todo.length}`); }
      await pause(150);
    }
  }));
  save();
}

const pool = Object.values(posts).filter(p => p.at >= since && p.full !== undefined);
if (!pool.length) { console.log(`${file} 里没有帖子。先运行 node scripts/company-problems.mjs --collect`); process.exit(1); }
const perAuthor = new Map(); for (const p of pool) perAuthor.set(p.author, (perAuthor.get(p.author) || 0) + 1);
const paid = new Set(pool.filter(p => p.paid).map(p => p.author));
const head = p => (p.title || p.full.trim().split('\n')[0] || '').slice(0, 60);
const mine = pool.filter(p => perAuthor.get(p.author) < 6 && !paid.has(p.author) && BYTE.test(head(p)) && !OTHER.test(head(p)));
const show = process.argv.includes('--show') ? process.argv[process.argv.indexOf('--show') + 1] : '';
console.log(`${since} 起的帖子 ${pool.length} 篇，最晚 ${pool.map(p => p.at).sort().at(-1)}；只谈字节、不是汇总号的 ${mine.length} 篇，账号 ${new Set(mine.map(p => p.author)).size} 个`);
for (const problem of COMPANY_PROBLEMS.values()) {
  const re = new RegExp(PATTERNS[problem.no].source, PATTERNS[problem.no].flags + 'g'), found = [];
  for (const p of mine) {
    const text = `${p.title}\n${p.full}`;
    const m = [...text.matchAll(re)].find(m => (MARK.test(text.slice(Math.max(0, m.index - 34), m.index)) || /手撕|手写|实现|写一?个/.test(m[0])) && !THEORY.test(text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 12).replace(/\n[\s\S]*$/, '')));
    if (m) found.push({ at: p.at, author: p.author, url: `https://www.nowcoder.com/${p.kind === 'moment' ? `feed/main/detail/${p.uuid}` : `discuss/${p.id}`}`, passage: text.slice(Math.max(0, m.index - 30), m.index + 170).replace(/\s+/g, ' ') });
  }
  found.sort((a, b) => b.at.localeCompare(a.at));
  if (!show) console.log(`${String(new Set(found.map(f => f.author)).size).padStart(3)} 个账号  ${found.at(-1)?.at.slice(0, 7) || '   -   '} 至 ${found[0]?.at.slice(0, 7) || '   -   '}  ${problem.no} ${problem.title}`);
  else if (show === problem.no) for (const f of found) console.log(`[${f.at}] ${f.url}\n  ${f.passage}`);
}
