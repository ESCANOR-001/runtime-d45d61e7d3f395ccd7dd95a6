type JsonRecord = Record<string, unknown>;

export type DesktopQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: false;
};

export type DesktopInteractions = {
  activeTurnId: string | null;
  compaction: { id: string; turnId: string; active: boolean; startedAt: number | null } | null;
  questions: { itemId: string; turnId: string; questions: DesktopQuestion[] }[];
  answeredIds: string[];
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rows(value: unknown): JsonRecord[] {
  return (Array.isArray(value) ? value : []).flatMap(value => record(value) ? [record(value)!] : []);
}

function inputText(value: unknown): string {
  return rows(value).filter(part => part.type === "text" || part.type === "input_text")
    .map(part => text(part.text)).join("");
}

export function desktopQuestionReplies(source: string): { questionItemId: string; question: string; answer: string }[] {
  const opening = "<send_user_message_question_reply>";
  const closing = "</send_user_message_question_reply>";
  const trimmed = source.trim();
  if (trimmed.length > 120_000 || !trimmed.startsWith(opening) || !trimmed.endsWith(closing)) return [];
  try {
    const decoded: unknown = JSON.parse(trimmed.slice(opening.length, -closing.length));
    const values = Array.isArray(decoded) ? decoded : [decoded];
    if (values.length > 32) return [];
    return values.flatMap(value => {
      const row = record(value);
      if (!text(row?.questionItemId) || !text(row?.question) || !text(row?.answer)) return [];
      return [{ questionItemId: text(row?.questionItemId), question: text(row?.question), answer: text(row?.answer) }];
    });
  } catch { return []; }
}

export function readDesktopInteractions(value: unknown, orderedTurns?: readonly JsonRecord[]): DesktopInteractions {
  const state = record(value);
  const turns = (orderedTurns ?? rows(state?.turns)).slice(-64);
  const answered = new Set<string>();
  const questions: DesktopInteractions["questions"] = [];
  for (const turn of turns) {
    const turnId = text(turn.turnId ?? turn.id);
    const inputs = [inputText(record(turn.params)?.input)];
    for (const item of rows(turn.items)) {
      if (item.type === "userMessage" || (item.type === "steeringUserMessage" && item.status === "accepted")) {
        inputs.push(inputText(item.content ?? item.input) || text(item.text));
      }
      if (item.type !== "agentMessage" || !text(item.id)) continue;
      const normalized = (Array.isArray(item.questions) ? item.questions : []).slice(0, 32).flatMap((value, index): DesktopQuestion[] => {
        const question = record(value);
        const prompt = text(question?.title).slice(0, 2048);
        if (!prompt) return [];
        return [{
          id: JSON.stringify(["request_user_input_async", item.id, index]),
          header: "Question",
          question: prompt,
          options: (Array.isArray(question?.options) ? question.options : []).slice(0, 32)
            .flatMap(option => typeof option === "string" && option.trim()
              ? [{ label: option.trim().slice(0, 256), description: option.trim().slice(0, 256) }] : []),
          multiSelect: false,
        }];
      });
      if (normalized.length) questions.push({ itemId: text(item.id), turnId, questions: normalized });
    }
    for (const input of inputs) {
      for (const reply of desktopQuestionReplies(input)) answered.add(reply.questionItemId);
    }
  }
  const latest = turns.at(-1);
  const compactionItem = rows(latest?.items).filter(item => item.type === "contextCompaction").at(-1);
  const turnTerminal = /^(completed|failed|interrupted|cancelled|canceled)$/i.test(text(latest?.status));
  const startedAt = compactionItem?.startedAtMs;
  const turnActive = /^(inprogress|running|pending|started|starting|active)$/i.test(text(latest?.status).replace(/_/g, ""));
  return {
    activeTurnId: turnActive ? text(latest?.turnId ?? latest?.id) || null : null,
    compaction: compactionItem && text(compactionItem.id) && text(latest?.turnId ?? latest?.id) ? {
      id: text(compactionItem.id),
      turnId: text(latest?.turnId ?? latest?.id),
      active: !turnTerminal && (compactionItem.completed === false || compactionItem.status === "inProgress"),
      startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null,
    } : null,
    questions: questions.map(group => ({ ...group, questions: group.questions.filter(question => !answered.has(question.id)) }))
      .filter(group => group.questions.length > 0),
    answeredIds: [...answered],
  };
}

export function desktopAnswerMessage(questions: DesktopQuestion[], answers: Record<string, { answers: string[] }>): string {
  const replies = questions.map(question => {
    const answer = answers[question.id]?.answers.join("\n").trim();
    if (!answer) throw new TypeError("Every question needs a non-empty answer");
    return { questionItemId: question.id, question: question.question, answer };
  });
  const message = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
  if (message.length > 120_000) throw new RangeError("Answer exceeds the message size limit");
  return message;
}
