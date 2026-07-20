const isRouterApp = (app, step) => /router/i.test(app || "") || !!(step && (step.routes || step.isRouter));
const isFilterApp = (app) => /filter/i.test(app || "");
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
      if (s.isRouter && !routes.length && s.note) {
        warnings.push({ code: "router-depth-capped", message: `${at} hit the recursion depth limit` });
      }
      if (hasFields(s)) counts.withData += 1;
      else if (routes.length) counts.withData += 1;
      return;
    }

    if (isFilterApp(s.app)) {
      const groups = s.filter || [];
      const conditions = groups.reduce((n, g) => n + ((g.conditions && g.conditions.length) || 0), 0);
      if (!conditions) {
        warnings.push({ code: "filter-no-conditions", message: `${at} is a filter with no parsed conditions` });
      } else {
        counts.withData += 1;
      }
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
