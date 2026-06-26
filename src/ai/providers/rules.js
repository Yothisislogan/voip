const EMPTY_COACHING = { cues: [], customerSentiment: "neutral" };

const LENSES = {
  objection: "objection",
  compliance: "compliance",
  next: "next_question",
  sentiment: "sentiment",
};

export function rulesStructuredCompletion({ user = "", schemaName = "" }) {
  const transcript = extractTranscript(user);
  if (!transcript.trim()) {
    return schemaName === "call_recap" ? emptyRecap() : EMPTY_COACHING;
  }

  if (schemaName === "call_recap") return buildRulesRecap(transcript);
  return buildRulesCoaching(transcript);
}

export function buildRulesCoaching(transcript) {
  const lines = parseLines(transcript);
  if (!lines.length) return EMPTY_COACHING;

  const recent = lines.slice(-12);
  const lastCustomer = [...recent].reverse().find((x) => x.speaker === "customer")?.text || "";
  const lastAgent = [...recent].reverse().find((x) => x.speaker === "agent")?.text || "";
  const all = recent.map((x) => x.text).join(" ").toLowerCase();
  const customer = lastCustomer.toLowerCase();
  const agent = lastAgent.toLowerCase();
  const cues = [];

  const add = (lens, text, priority = "normal") => {
    if (!text) return;
    if (cues.some((c) => c.text === text)) return;
    if (cues.length >= 3) return;
    cues.push({ lens, priority, text });
  };

  if (matches(customer, ["too expensive", "too high", "cost", "price", "premium", "cheaper", "can't afford", "cant afford", "payment"])) {
    add(LENSES.objection, "Ask what part feels high: down payment, monthly price, or coverage.", "high");
  }

  if (matches(customer, ["think about", "call me back", "later", "not today", "i'll let you know", "ill let you know", "talk to my", "spouse", "husband", "wife"])) {
    add(LENSES.objection, "Ask what concern they want cleared up before deciding.", "high");
  }

  if (matches(customer, ["already have", "current insurance", "with geico", "with progressive", "state farm", "allstate", "usaa", "farmers", "nationwide"])) {
    add(LENSES.next, "Ask renewal date, current premium, and what they would improve.");
  }

  if (matches(customer, ["don't understand", "dont understand", "confused", "what does that mean", "deductible", "liability", "coverage", "covered"])) {
    add(LENSES.sentiment, "Slow down and explain one coverage choice at a time.");
  }

  if (matches(customer, ["just need", "minimum", "state minimum", "cheapest", "legal"])){ 
    add(LENSES.compliance, "Explain minimum limits may leave them personally exposed.", "high");
  }

  if (matches(all, ["recorded", "transcribed", "quality and training"]) === false) {
    add(LENSES.compliance, "Make sure call recording and transcription disclosure was given.");
  }

  if (agent.length > 220 && !/[?]/.test(lastAgent)) {
    add(LENSES.sentiment, "Pause and ask a question; the agent may be talking too long.");
  }

  if (!recent.some((x) => x.speaker === "agent" && /email|phone|address|vin|driver|date of birth|dob/i.test(x.text))) {
    add(LENSES.next, "Confirm contact info and the key rating details before quoting.");
  }

  if (!recent.some((x) => x.speaker === "agent" && /start|bind|move forward|today|set this up|buy|purchase/i.test(x.text))) {
    add(LENSES.next, "Ask if they want to move forward once the quote is clear.");
  }

  if (!cues.length && customer) {
    add(LENSES.next, "Ask one clear discovery question, then let the customer answer.");
  }

  return {
    cues,
    customerSentiment: sentimentFor(all),
  };
}

export function buildRulesRecap(transcript) {
  const lines = parseLines(transcript);
  const text = lines.map((x) => x.text).join(" ");
  const lower = text.toLowerCase();
  const products = productsDiscussed(lower);
  const objections = objectionsDiscussed(lower);
  const nextSteps = nextStepsFrom(lower);

  return {
    summary: summarize(lines),
    outcome: outcomeFrom(lower),
    productsDiscussed: products,
    objections,
    nextSteps,
    followUpDate: "",
    customerSentiment: sentimentFor(lower),
  };
}

function extractTranscript(user) {
  return String(user || "")
    .replace(/^Live call transcript so far \(most recent last\):/i, "")
    .replace(/^Completed call transcript:/i, "")
    .replace(/Give the agent cues[\s\S]*$/i, "")
    .replace(/Extract the recap\.?/i, "")
    .trim();
}

function parseLines(transcript) {
  return String(transcript || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(Agent|Customer)\s*:\s*(.*)$/i);
      if (!m) return { speaker: "customer", text: line };
      return { speaker: m[1].toLowerCase() === "agent" ? "agent" : "customer", text: m[2].trim() };
    })
    .filter((x) => x.text);
}

function matches(text, needles) {
  const s = String(text || "").toLowerCase();
  return needles.some((n) => s.includes(n));
}

function sentimentFor(text) {
  const s = String(text || "").toLowerCase();
  const negative = ["angry", "mad", "frustrated", "too expensive", "cancel", "not interested", "confused", "don't understand", "dont understand"];
  const positive = ["sounds good", "great", "perfect", "let's do", "lets do", "move forward", "thank you", "appreciate"];
  if (matches(s, negative)) return "negative";
  if (matches(s, positive)) return "positive";
  return "neutral";
}

function productsDiscussed(lower) {
  const out = [];
  if (matches(lower, ["auto", "car", "vehicle", "vin"])) out.push("Auto");
  if (matches(lower, ["home", "house", "homeowners"])) out.push("Home");
  if (matches(lower, ["renters", "apartment"])) out.push("Renters");
  if (matches(lower, ["workers comp", "workers compensation", "payroll"])) out.push("Workers Compensation");
  if (matches(lower, ["general liability", "gl", "liability insurance"])) out.push("General Liability");
  if (matches(lower, ["commercial auto", "business auto", "box truck", "tow truck"])) out.push("Commercial Auto");
  return out;
}

function objectionsDiscussed(lower) {
  const out = [];
  if (matches(lower, ["too expensive", "too high", "price", "cost", "premium"])) out.push("Price concern");
  if (matches(lower, ["think about", "not today", "later", "call me back"])) out.push("Needs time or callback");
  if (matches(lower, ["already have", "current insurance"])) out.push("Has current insurance");
  if (matches(lower, ["confused", "don't understand", "dont understand"])) out.push("Needs clearer explanation");
  return out;
}

function nextStepsFrom(lower) {
  const out = [];
  if (matches(lower, ["call back", "follow up", "tomorrow", "next week"])) out.push("Follow up with customer");
  if (matches(lower, ["quote", "rate", "premium"])) out.push("Review or present quote");
  if (matches(lower, ["vin", "driver", "date of birth", "dob", "address"])) out.push("Confirm missing rating information");
  if (matches(lower, ["move forward", "bind", "start", "effective"])) out.push("Prepare bind/start process");
  return out.length ? out : ["Review call and determine next action"];
}

function outcomeFrom(lower) {
  if (matches(lower, ["bind", "bound", "payment", "move forward", "start today"])) return "sale";
  if (matches(lower, ["quote", "rate", "premium"])) return "quote_requested";
  if (matches(lower, ["call back", "follow up", "tomorrow", "next week"])) return "follow_up";
  if (matches(lower, ["not interested", "no thanks"])) return "not_interested";
  return "other";
}

function summarize(lines) {
  const recent = lines.slice(-8).map((x) => `${cap(x.speaker)}: ${x.text}`).join(" ");
  if (!recent) return "Call completed. Review the transcript for details.";
  return `Call discussed insurance needs and next steps. Recent exchange: ${recent.slice(0, 420)}${recent.length > 420 ? "..." : ""}`;
}

function emptyRecap() {
  return {
    summary: "No transcript was available for recap.",
    outcome: "other",
    productsDiscussed: [],
    objections: [],
    nextSteps: [],
    followUpDate: "",
    customerSentiment: "neutral",
  };
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Speaker";
}
