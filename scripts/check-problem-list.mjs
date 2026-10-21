// Compares src/problem-list.js with the sites it was taken from. Run from the project directory:
//   node scripts/check-problem-list.mjs
// It prints what differs and changes nothing. Sources: the problem data embedded in the AlgoMooc 200 page,
// leetcode.com's problem index and its "Top 100 Liked" study plan (the same 100 problems as 热题 100 on
// leetcode.cn), and leetcode.cn's titles. leetcode.cn often refuses requests from scripts; the titles are then
// left unchecked and the output says so. The company problems of that file are not LeetCode problems and are not
// checked here: scripts/company-problems.mjs counts how often they are reported.
import { PROBLEMS } from '../src/problem-list.js';

const agent = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const get = async (url, options = {}) => { const res = await fetch(url, { ...options, headers: { ...agent, ...options.headers } }); if (!res.ok) throw Error(`${url} 返回 ${res.status}`); return res; };
const graphql = async (site, query, variables) => (await (await get(`https://${site}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })).json()).data;

// The page is a Next.js app: its data arrives as self.__next_f.push([1,"<escaped text>"]) chunks.
const html = await (await get('https://www.algomooc.com/leetcode-animation/algomooc200')).text();
let payload = ''; for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) payload += JSON.parse(m[1]);
const start = payload.indexOf('"groups":['); if (start < 0) throw Error('AlgoMooc 页面里没有找到题目数据，页面结构可能变了');
let end = start + 9, depth = 0, quoted = false;
for (; end < payload.length; end++) {
  const c = payload[end];
  if (quoted) { if (c === '\\') end++; else if (c === '"') quoted = false; }
  else if (c === '"') quoted = true; else if (c === '[' || c === '{') depth++; else if ((c === ']' || c === '}') && --depth === 0) break;
}
const groups = JSON.parse(payload.slice(start + 9, end + 1));
const index = (await (await get('https://leetcode.com/api/problems/all/')).json()).stat_status_pairs.map(p => p.stat);
const titles = await graphql('leetcode.cn', 'query { translations: allAppliedQuestionTranslations { title questionId } }').then(d => new Map(d.translations.map(t => [String(t.questionId), t.title.trim()])), () => null);
const official = new Map(index.map(s => [String(s.frontend_question_id), { slug: s.question__title_slug, title: titles?.get(String(s.question_id)) }]));
const plan = (await graphql('leetcode.com', 'query ($slug: String!) { studyPlanV2Detail(planSlug: $slug) { planSubGroups { questions { questionFrontendId } } } }', { slug: 'top-100-liked' })).studyPlanV2Detail.planSubGroups;
const hot = new Set(plan.flatMap(g => g.questions.map(q => q.questionFrontendId)));

const site = new Map(groups.flatMap(g => g.problems.map(p => [String(p.num), { group: g.name, slug: p.slug }])));
const wanted = new Set([...site.keys(), ...hot]), found = [];
if (!titles) console.log('leetcode.cn 拒绝了请求，这一次没有核对中文题名');
for (const no of wanted) if (!PROBLEMS.has(no)) found.push(`缺少 ${no} ${official.get(no)?.title || ''}`);
for (const [no, p] of PROBLEMS) {
  if (!wanted.has(no)) found.push(`多出 ${no} ${p.title}（两个来源里都没有）`);
  if (!official.has(no)) { found.push(`${no} ${p.title}：LeetCode 上没有这个题号`); continue; }
  if (official.get(no).title && official.get(no).title !== p.title) found.push(`${no} 题名不同：文件「${p.title}」，leetcode.cn「${official.get(no).title}」`);
  if (p.hot !== hot.has(no)) found.push(`${no} ${p.title}：热题 100 标记不对，应为${hot.has(no) ? '有' : '无'}`);
  if (site.has(no) && site.get(no).group !== p.group) found.push(`${no} ${p.title}：分组不同，文件「${p.group}」，AlgoMooc「${site.get(no).group}」`);
}
console.log(`AlgoMooc 200：${site.size} 题；热题 100：${hot.size} 题；两者合计 ${wanted.size} 题；src/problem-list.js：${PROBLEMS.size} 题`);
console.log(found.length ? found.join('\n') : '没有差异');
process.exitCode = found.length ? 1 : 0;
