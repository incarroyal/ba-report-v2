// netlify/functions/ai-parse.mjs
// 보장분석 리포트 / 가입제안서 PDF를 Claude(Anthropic)로 구조화 추출하는 통합 프록시.
// ANTHROPIC_API_KEY 는 Netlify 환경변수에만 설정 (클라이언트 노출 금지).
// mode: "report"   → 롯데 보장분석 리포트(분할된 페이지 묶음)에서 [별첨] 계약별 담보 추출
// mode: "list"     → '보유계약 리스트' 요약표에서 보험사·상품명·납입회차 등 정확한 계약 메타 추출
// mode: "proposal" → 타사 가입제안서에서 담보 추출
// mode: "ping"     → 키/모델 연결 진단
// 두 모드 모두 담보를 '표준 카테고리'로 매핑해 보험사 간 명칭 차이를 흡수한다.

// 모델: 기본은 빠르고 저렴한 Haiku. 정확도가 부족하면 Netlify 환경변수
//   CLAUDE_MODEL 을 "claude-sonnet-4-6" 으로 설정해 업그레이드.
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// 표준 담보 카테고리 — 프런트(index.html)의 GROUPS와 1:1 동기화 필수
const CATEGORIES = [
  "질병사망","상해사망",
  "질병후유장해","상해후유장해",
  "질병입원의료비","질병통원의료비","상해입원의료비","상해통원의료비",
  "일반암진단비","유사암진단비","전이암진단비","암수술비","고액암치료비","암입원·통원·기타",
  "뇌혈관질환진단비","뇌졸중진단비","뇌출혈진단비","뇌혈관질환수술비",
  "허혈성심장질환진단비","급성심근경색진단비","심장질환수술비",
  "질병수술비","상해수술비","종수술비(1~5종)","특정질병수술비",
  "질병입원일당","상해입원일당","간병인사용지원",
  "장기요양자금","치매진단비",
  "교통사고처리지원금","변호사선임비용","벌금(대인)","벌금(대물)","자동차사고부상위로금",
  "일상생활배상책임","골절진단비","깁스치료비","화재벌금","응급실내원비",
  "기타"
];

const COV_ITEM = {
  type: "object",
  properties: {
    name:   { type: "string",  description: "담보명 원문(순번·고지구분 접두어 제거)" },
    catIdx: { type: "integer", description: "표준 카테고리 번호(프롬프트의 번호표 참조). 해당 없으면 40(기타)" },
    amt:    { type: "integer", description: "가입금액(만원 단위 정수)" }
  },
  required: ["name", "catIdx", "amt"]
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    contracts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insurer:        { type: "string",  description: "보험사명 (예: 흥국생명, DB생명, 롯데손해보험, DB손해보험, NH농협손해보험, KB손해보험, 메리츠화재, 삼성화재, 현대해상, 한화손해보험, 메트라이프생명)" },
          productName:    { type: "string",  description: "보험서비스(상품)명" },
          monthlyPremium: { type: "integer", description: "보험료(원). 페이지 상단 헤더의 숫자" },
          payProgress:    { type: "string",  description: "납입횟수 (예: 41/240)" },
          payTerm:        { type: "string",  description: "납입주기/기간 (예: 월납/20년)" },
          period:         { type: "string",  description: "보장기간 (예: 2023.01.10~2043.01.10)" },
          covs:           { type: "array", items: COV_ITEM }
        },
        required: ["insurer", "productName", "covs"]
      }
    }
  },
  required: ["contracts"]
};

// 보유계약 리스트(요약 표) 전용 — 보험사·상품명·납입회차 등 '정확한 계약 메타'만 추출 (담보 없음)
const LIST_SCHEMA = {
  type: "object",
  properties: {
    contracts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insurer:        { type: "string",  description: "회사(보험사)명. '회사/보험서비스(상품)명' 칸의 윗줄" },
          productName:    { type: "string",  description: "보험서비스(상품)명. '회사/보험서비스(상품)명' 칸의 아랫줄(여러 줄이면 전체를 한 문자열로 합침)" },
          monthlyPremium: { type: "integer", description: "'보험료' 칸의 금액(원). 기납입보험료·잔여보험료와 절대 혼동 금지" },
          payProgress:    { type: "string",  description: "'납입횟수' 칸 값 그대로 (예: 41/240, 0/0)" },
          payCycle:       { type: "string",  description: "'납입주기' 칸 (예: 월납, 연납, 일시납)" },
          contractDate:   { type: "string",  description: "계약일 (예: 2023.01.10)" },
          maturityDate:   { type: "string",  description: "만기일 (예: 2043.01.10)" }
        },
        required: ["insurer", "productName", "monthlyPremium"]
      }
    }
  },
  required: ["contracts"]
};

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    insurer:        { type: "string" },
    productName:    { type: "string" },
    monthlyPremium: { type: "integer", description: "월 보장보험료(원)" },
    payYears:       { type: "integer", description: "납입 년수" },
    term:           { type: "string",  description: "보장만기 (예: 100세만기)" },
    covs:           { type: "array", items: COV_ITEM }
  },
  required: ["insurer", "covs"]
};

const MAPPING_RULES = `
[표준 카테고리 번호표 — catIdx 는 반드시 아래 번호로]
${CATEGORIES.map((c, i) => `${i}=${c}`).join(', ')}
[매핑 규칙 — 보험사마다 명칭이 달라도 의미로 매핑]
- '유사암'에는 제자리암·경계성종양·갑상선암·기타피부암·소액암이 포함됨 → 유사암진단비
- '뇌혈관질환'은 뇌졸중·뇌출혈을 포괄하는 상위 개념. '뇌졸중'은 뇌졸중진단비, '뇌출혈'은 뇌출혈진단비로 각각 구분
- '허혈성심장질환'은 급성심근경색을 포괄. '급성심근경색'만 명시되면 급성심근경색진단비
- 1~5종 / 1~7종 수술비, N종수술비 → 종수술비(1~5종)
- 특정질병·N대질병 수술비 → 특정질병수술비
- 후유장해 3%·3~100%·80%이상 모두 → 질병/상해 후유장해
- 표적항암약물치료비·항암방사선약물치료비·세기조절방사선·다빈치로봇 등 고액 암치료 → 고액암치료비
- 암직접치료입원일당·암통원·항암통원 → 암입원·통원·기타
- 운전자 관련: 교통사고처리지원금(형사합의금 포함), 변호사선임비용, 벌금(대인/대물 구분), 자동차사고부상위로금(부상치료비)
- 간병인사용·간병인지원 입원일당 → 간병인사용지원
- 일상생활중배상책임·가족일상생활배상책임 → 일상생활배상책임
- 위에 없는 담보(여행자·치아·운전자휴업 등)는 '기타'
[금액 규칙]
- 가입금액은 반드시 '만원' 단위 정수: 1억원=10000, 3억=30000, 5천만원=5000, 5백만원=500, 30만원=30, "101,135만원"=101135
- 일당류(입원일당 등)는 표기된 만원 금액 그대로 (예: 3만원=3)
- 가입금액 0 또는 '-' 인 담보는 제외
[공통 제외]
- 보험료납입면제·납입지원 등 행정성 담보, 소계/합계 행 제외
- 담보명 앞 순번·'(건강고지)'·'(간편고지)' 접두어 제거 (단 '116대질병'처럼 명칭 일부인 숫자는 보존)`;

const REPORT_PROMPT = `이 PDF는 한국 손해보험사의 '보장분석 리포트' 중 일부 페이지 묶음입니다.
'[별첨] 보험서비스(상품)별 보장 현황' 형식의 페이지에서만 계약 정보를 추출하세요. 별첨 페이지 1장 = 계약 1건입니다.
리포트는 세로형/가로형 등 레이아웃이 다양하며, 별첨 페이지의 담보 표는 (담보명|가입금액) 열이 2단 또는 3단으로 반복될 수 있습니다. 모든 단(컬럼 그룹)의 담보를 빠짐없이 추출하세요.
표지·요약(보유계약 현황)·한장보장현황·세부가입현황·안내 및 유의사항 페이지는 모두 무시하세요.
각 별첨 페이지에서: 보험사명, 상품명, 보험료(원), 납입횟수(예: 41/240), 보장기간, 그리고 담보 표의 모든 (담보명, 가입금액)을 추출합니다.
페이지 상단 헤더에 작게 표기된 납입정보/보험료/기간을 정확히 읽으세요.
보험사명이 페이지에서 불명확하면 임의로 추정하지 말고(특히 무조건 '롯데손해보험'으로 채우지 말 것), 페이지에 보이는 상품명만 정확히 적으세요. 보험사·상품명·납입회차는 요약표(list 모드) 기준으로 별도 보정되므로, 여기서는 담보(covs) 추출의 정확도에 집중하세요.
보험료가 소액이거나 만기가 임박한 계약도 별첨 페이지가 있으면 모두 추출 대상입니다.
${MAPPING_RULES}
반드시 ${"extract_contracts"} 도구를 호출해 결과를 반환하세요.`;

const LIST_PROMPT = `이 PDF는 한국 손해보험 '보장분석 리포트'의 '보유계약 리스트(요약 표)' 페이지입니다.
표의 모든 행(계약)을 빠짐없이 추출하세요. 각 행에서 다음을 정확히 읽습니다.
- 회사(보험사)명: '회사 / 보험서비스(상품)명' 칸의 윗줄 (예: 흥국생명, DB생명, 메트라이프생명, 메리츠화재). 절대 임의로 '롯데손해보험'으로 채우지 마세요.
- 상품명: 같은 칸의 아랫줄. 여러 줄로 줄바꿈되어 있으면 전체를 하나의 문자열로 합치세요 (예: (무)흥국생명다(多)사랑통합보험V2(갱신형)(최초)).
- 계약일, 만기일: 'YYYY.MM.DD' 형식.
- 납입주기: 월납/연납/일시납 등.
- 납입횟수: '납입횟수' 칸 값 그대로 (예: 41/240, 0/0).
- 보험료(원): '보험료' 칸의 금액. 그 오른쪽의 '기납입보험료'·'잔여보험료'와 혼동하지 마세요. 셋 중 가장 왼쪽(가장 작은 월 단위 금액)이 보험료입니다.
보험료가 0원인 행도 포함하세요.
반드시 ${"extract_list"} 도구를 호출해 결과를 반환하세요.`;

const PROPOSAL_PROMPT = `이 PDF는 한국 손해보험 '가입제안서'입니다. 담보(보장) 목록 표에서 각 담보명과 가입금액을 정확히 추출하세요.
같은 담보가 여러 줄(소계)로 나뉘면 대표(총액) 한 줄만 남기세요.
보험사명·상품명·월 보장보험료(원)·납입년수·보장만기도 함께 추출하세요.
${MAPPING_RULES}
반드시 ${"extract_proposal"} 도구를 호출해 결과를 반환하세요.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Claude(Anthropic) 호출 — Netlify 10초 강제 종료 전에 자체 9초 컷
async function callClaude(body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    return await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } finally { clearTimeout(timer); }
}

// catIdx(번호) → 표준 카테고리명 변환 (프런트는 기존처럼 category 문자열 수신)
function finalize(obj, isReport) {
  const fix = covs => (covs || []).map(v => ({ name: v.name, category: CATEGORIES[v.catIdx] ?? "기타", amt: v.amt }));
  if (isReport && Array.isArray(obj.contracts)) obj.contracts.forEach(c => { c.covs = fix(c.covs); });
  if (!isReport) obj.covs = fix(obj.covs);
  return json(obj);
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let mode, pdfBase64;
  try { ({ mode = "report", pdfBase64 } = await req.json()); }
  catch { return json({ error: "잘못된 요청 본문" }, 400); }

  // ---- 진단 모드: 키·연결 상태를 점검 ----
  if (mode === "ping") {
    if (!process.env.ANTHROPIC_API_KEY)
      return json({ ok: false, step: "env", error: "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify → Site configuration → Environment variables 에 추가 후 재배포하세요." });
    try {
      const r = await callClaude({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
      if (!r.ok) {
        const t = await r.text();
        return json({ ok: false, step: "claude", error: `Claude 호출 실패 (HTTP ${r.status}, 모델: ${MODEL})`, detail: t.slice(0, 400) });
      }
      return json({ ok: true, model: MODEL });
    } catch (e) {
      return json({ ok: false, step: "claude", error: String(e) });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY)
    return json({ error: "ANTHROPIC_API_KEY 미설정 (Netlify 환경변수 확인)" }, 500);
  if (!pdfBase64) return json({ error: "pdfBase64 누락" }, 400);

  const isReport = mode === "report";
  const isList   = mode === "list";
  const toolName = isList ? "extract_list" : isReport ? "extract_contracts" : "extract_proposal";
  const schema   = isList ? LIST_SCHEMA   : isReport ? REPORT_SCHEMA      : PROPOSAL_SCHEMA;
  const prompt   = isList ? LIST_PROMPT   : isReport ? REPORT_PROMPT      : PROPOSAL_PROMPT;

  // tool_choice 로 구조화 출력 강제 (Gemini responseSchema 와 동등)
  const body = {
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    tools: [{ name: toolName, description: "추출한 보험 계약/담보 데이터를 이 도구로 반환한다", input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: prompt }
      ]
    }]
  };

  try {
    const r = await callClaude(body);
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 429) return json({ error: "API 사용량 제한 (HTTP 429) — 잠시 후 자동 재시도됩니다", detail: t.slice(0, 200) }, 429);
      return json({ error: `Claude 호출 실패 (HTTP ${r.status}, 모델: ${MODEL})`, detail: t.slice(0, 400) }, 502);
    }
    const data = await r.json();
    // tool_use 블록에서 구조화 결과 추출
    const toolBlock = (data.content || []).find(b => b.type === "tool_use");
    if (toolBlock && toolBlock.input) return isList ? json(toolBlock.input) : finalize(toolBlock.input, isReport);
    // 혹시 도구를 안 쓰고 텍스트로 왔으면 파싱 시도
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("").trim();
    const clean = text.replace(/```json|```/g, "").trim();
    try { const parsed = JSON.parse(clean); return isList ? json(parsed) : finalize(parsed, isReport); }
    catch { return json({ error: "AI 응답 파싱 실패", raw: clean.slice(0, 300) }, 502); }
  } catch (e) {
    if (e.name === "AbortError" || /abort/i.test(String(e)))
      return json({ error: "분석 시간 초과 — 페이지 구간이 너무 큽니다 (자동으로 더 작게 나눠 재시도됩니다)" }, 504);
    return json({ error: String(e) }, 500);
  }
};
