// Zapier's branch and condition steps are called "Paths by Zapier" and "Filter by Zapier", so
// matching on the word "router" alone misses them. An adapter that already knows a step's role
// states it in `type`, and that is then authoritative — name matching is only for steps that
// arrive untyped (Pabbly's), where it would otherwise misread an app merely called "…Filter…".
const isRouterApp = (app, step) => {
  if (step && step.type) return step.type === "router" || !!step.routes;
  return /router|paths?\s+by\s+zapier/i.test(app || "") || !!(step && (step.routes || step.isRouter));
};

const isFilterApp = (app, step) => {
  if (step && step.type) return step.type === "filter";
  return /filter|only\s+continue/i.test(app || "");
};
const hasFields = (s) => !!(s.mappings && s.mappings.length);

const label = (s, i) => `step ${s.indexLabel || s.order || i + 1}${s.app ? ` (${s.app})` : ""}`;

const walk = (steps, warnings, counts, where) => {
  (steps || []).forEach((s, i) => {
    counts.total += 1;
    const at = where ? `${where} › ${label(s, i)}` : label(s, i);

    if (!s.app) warnings.push({ code: "step-no-app", message: `${at} has no app identified` });

    if (isRouterApp(s.app, s)) {
      const routes = s.routes || [];
      if (!routes.length) {
        warnings.push({ code: "router-no-routes", message: `${at} is a router but no routes were captured` });
      }
      routes.forEach((r) => {
        counts.routes += 1;
        const rAt = `${at} › route "${r.routeName || r.routeOrder}"`;
        if (!r.steps || !r.steps.length) {
          warnings.push({ code: "route-empty", message: `${rAt} has no child steps` });
          return;
        }
        walk(r.steps, warnings, counts, rAt);
      });
      if ((s.isRouter || s.depthCapped) && !routes.length && (s.note || s.depthCapped)) {
        warnings.push({ code: "router-depth-capped", message: `${at} hit the recursion depth limit` });
      }
      if (hasFields(s)) counts.withData += 1;
      else if (routes.length) counts.withData += 1;
      return;
    }

    if (isFilterApp(s.app, s)) {
      const groups = s.filter || [];
      const conditions = groups.reduce((n, g) => n + ((g.conditions && g.conditions.length) || 0), 0);
      const resolved = groups.reduce(
        (n, g) => n + ((g.conditions || []).filter((c) => !c.unresolved).length),
        0
      );

      // Pabbly's own error, not ours: when a filter's mapped source is deleted it renders the row with
      // an empty Select Label and Value and shows "Error in filter mapping detected". There is nothing
      // on screen to read, so calling it "no parsed conditions" blamed the capture for a broken filter
      // in the account — and hid the fact that the branch may no longer gate correctly at runtime.
      if (s.filterMappingBroken) {
        warnings.push({
          code: "filter-mapping-broken",
          message: `${at} — Pabbly reports its filter mapping is broken (mapped step or key deleted), so the condition is unreadable in the editor. Fix it in Pabbly; this is not a capture gap.`
        });
        return;
      }

      if (!conditions) {
        warnings.push({ code: "filter-no-conditions", message: `${at} is a filter with no parsed conditions` });
        return;
      }
      if (!resolved) {
        warnings.push({
          code: "filter-conditions-unresolved",
          message: `${at} has ${conditions} condition(s) but no operands were readable — the mapped source is likely gone`
        });
        return;
      }
      counts.withData += 1;
      return;
    }

    // A trigger can legitimately take no configuration — a Zapier catch-hook has none — so an empty
    // one is fully captured, not a gap. Only steps whose adapter declared a type get this pass; an
    // untyped step with no fields is still worth flagging.
    if (s.type === "trigger" && !hasFields(s)) {
      counts.withData += 1;
      return;
    }

    // Said separately from "no field mappings" because they mean opposite things to a reader: one is a
    // fact about the automation, the other is a gap in the capture. Conflating them let a step nobody
    // managed to read pass as a step with nothing in it.
    if (s.expanded === false || s.notRead) {
      warnings.push({
        code: "step-not-read",
        message: `${at} was never opened — its configuration is missing, not empty. Re-capture.`
      });
      return;
    }

    if (!hasFields(s)) {
      warnings.push({ code: "action-no-fields", message: `${at} captured no field mappings` });
      return;
    }
    counts.withData += 1;
  });
};

export const analyzeSteps = (steps, error) => {
  const warnings = [];
  const counts = { total: 0, withData: 0, routes: 0 };

  if (error) {
    return {
      level: "failed",
      score: 0,
      counts,
      warnings: [{ code: "capture-error", message: String(error) }]
    };
  }

  if (!steps || !steps.length) {
    return {
      level: "failed",
      score: 0,
      counts,
      warnings: [{ code: "no-steps", message: "No steps were captured for this workflow" }]
    };
  }

  walk(steps, warnings, counts, "");

  const score = counts.total ? Math.round((counts.withData / counts.total) * 100) : 0;
  const level = score === 100 && !warnings.length ? "complete" : score >= 60 ? "partial" : "poor";
  return { level, score, counts, warnings };
};

export const levelPill = (level) =>
  level === "complete" ? "high" : level === "partial" ? "medium" : "low";
