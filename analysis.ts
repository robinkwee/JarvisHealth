export interface MacroEstimate {
  description: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  confidence: string;
  notes?: string;
}

export function parseAnalysisResponse(text: string): MacroEstimate | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed.error) return null;
    return parsed as MacroEstimate;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as MacroEstimate; } catch { }
    }
    return null;
  }
}

export function buildEditPrompt(description: string): string {
  return `✏️ *Editing: ${description}*\n\nDescribe what you had and I'll re-estimate:\n\n• \`Big Mac + medium fries\`\n• \`grilled salmon, 150g\`\n• \`chicken tikka masala with rice\``;
}

export function buildEstimateMessage(estimate: MacroEstimate, suffix = ""): string {
  const confidenceEmoji = estimate.confidence === "high" ? "✅" : estimate.confidence === "medium" ? "⚠️" : "❓";
  return `${confidenceEmoji} *${estimate.description}*${suffix}\n\n` +
    `🔥 Calories: *${estimate.calories} kcal*\n` +
    `💪 Protein: ${estimate.protein_g}g\n` +
    `🍞 Carbs: ${estimate.carbs_g}g\n` +
    `🥑 Fat: ${estimate.fat_g}g\n` +
    `🌿 Fiber: ${estimate.fiber_g}g\n` +
    (estimate.notes ? `\n_Note: ${estimate.notes}_\n` : "") +
    `\nLog this?`;
}
