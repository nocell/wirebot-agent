import type { RoutingDecision } from "../core/auto-routing.js";
import type { EffortSetting } from "../core/settings-store.js";

/**
 * Auto effort: pick an effort level per message from the request text with
 * local heuristics, so routing costs no extra model call.
 */
const effortForTask: Readonly<Record<RoutingDecision["task"], EffortSetting>> = {
  simple: "low",
  question: "medium",
  task: "high",
  complex: "xhigh",
  research: "max",
  bug_research: "max",
};

export function autoEffort(
  text: string,
  hasAttachments: boolean,
  supported: readonly EffortSetting[] | undefined,
): EffortSetting | undefined {
  const requested = effortForTask[fallbackDecision(text, hasAttachments).task];
  if (supported === undefined) return requested;
  if (supported.length === 0) return undefined;
  const order: readonly EffortSetting[] = ["low", "medium", "high", "xhigh", "max"];
  return order
    .slice(0, order.indexOf(requested) + 1)
    .reverse()
    .find((effort) => supported.includes(effort));
}

/** Unambiguous speed requests also work when subscription classification is unavailable. */
export function explicitSpeed(text: string): boolean | undefined {
  if (
    /\b(?:no rush|take your time|standard speed|slow mode|(?:don't|do not|no need to)\s+(?:rush|be quick|answer quickly|respond quickly|do it quickly|use (?:ultrafast|fast)(?: mode)?))\b|не\s+(?:спеши|торопись)|без\s+спешки|медленный\s+режим/iu.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:please\s+)?(?:be quick|answer quickly|respond quickly|do it quickly|asap|use (?:ultrafast|fast)(?: mode)?)\b|^(?:quickly|quick answer|ultrafast|fast mode)\b|(?:ответь|сделай|проверь)\s+(?:пожалуйста\s+)?быстро|^быстро(?![\p{L}\p{N}_])/iu.test(
      text,
    )
  )
    return true;
  return undefined;
}

/** Classify a request locally from its wording. */
export function fallbackDecision(text: string, hasAttachments: boolean): RoutingDecision {
  const fast = explicitSpeed(text) ?? false;
  if (
    /\b(?:debug|investigate|root cause|bug research|bug-research|diagnos\w*)\b|расслед|отлад|причин.*(?:баг|ошиб|сбо)|исслед.*(?:баг|ошиб)/iu.test(
      text,
    )
  )
    return { task: "bug_research", fast };
  if (
    /\b(?:deep research|in.depth research|research thoroughly|comprehensive research)\b|глубок.*исслед|подробн.*исслед/iu.test(
      text,
    )
  )
    return { task: "research", fast };
  if (/\b(?:architect|migration|refactor|multi.step)\b|архитектур|миграци|рефактор/iu.test(text))
    return { task: "complex", fast };
  if (
    !hasAttachments &&
    text.length < 300 &&
    /\b(?:translate|define|capital of|what time|hello|hi)\b|переведи|привет|который час/iu.test(
      text,
    )
  )
    return { task: "simple", fast };
  if (
    !hasAttachments &&
    text.length < 500 &&
    /\?|^(?:what|why|how|explain)\b|^(?:что|как|почему|объясни)(?![\p{L}\p{N}_])/iu.test(text)
  )
    return { task: "question", fast };
  return { task: "task", fast };
}
