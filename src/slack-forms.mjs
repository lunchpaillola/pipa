export function formQuestion(entry) {
  const fields = entry.request.fields;
  const unsupported = { header: entry.request.title || "OpenCode form", unsupported: true, question: "Slack cannot answer this unsupported or malformed field. You can dismiss this form." };
  if (!Array.isArray(fields) || !fields.length) return unsupported;
  const effective = Object.create(null);
  const earlier = new Set();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field || typeof field.key !== "string" || !field.key || earlier.has(field.key)
      || !["string", "number", "integer", "boolean", "multiselect", "external"].includes(field.type)
      || field.when !== undefined && (!Array.isArray(field.when) || field.when.some(condition => !condition || !earlier.has(condition.key) || !["eq", "neq"].includes(condition.op) || !["string", "number", "boolean"].includes(typeof condition.value)))
      || field.options !== undefined && (!Array.isArray(field.options) || field.options.some(option => !option || typeof option.label !== "string" || typeof option.value !== "string"))
      || field.type === "multiselect" && !Array.isArray(field.options)) {
      entry.questionIndex = index;
      return unsupported;
    }
    earlier.add(field.key);
    const active = (field.when ?? []).every(condition => {
      if (!Object.hasOwn(effective, condition.key)) return false;
      const value = effective[condition.key];
      const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
      return condition.op === "eq" ? equal : !equal;
    });
    if (!active) {
      delete entry.formAnswer[field.key];
      continue;
    }
    if (Object.hasOwn(entry.formAnswer, field.key)) effective[field.key] = entry.formAnswer[field.key];
    else if (Object.hasOwn(field, "default")) effective[field.key] = field.default;
    if (index < entry.questionIndex || field.hidden && (Object.hasOwn(field, "default") || !field.required)) continue;
    entry.questionIndex = index;
    let url;
    if (field.type === "external") {
      try {
        const parsed = new URL(field.url);
        if (!["http:", "https:"].includes(parsed.protocol)) return unsupported;
        url = parsed.href;
      } catch { return unsupported; }
    }
    const options = field.type === "boolean" ? [{ label: "Yes", value: true }, { label: "No", value: false }] : field.options;
    return {
      field, url, header: field.title || entry.request.title || "OpenCode form",
      question: field.description || field.title || field.key,
      required: field.type === "external" || field.required === true && !Object.hasOwn(field, "default"),
      multiple: field.type === "multiselect", options,
      custom: field.type !== "external" && field.type !== "boolean" && (field.custom || !options?.length),
    };
  }
  entry.questionIndex = fields.length;
  return { header: entry.request.title || "OpenCode form", question: "Ready to submit using the defaults for omitted fields.", completed: true, answer: { ...effective } };
}

export function textFormAnswer(question, text) {
  const field = question.field;
  if (["number", "integer"].includes(field.type)) {
    const value = text.trim() === "" ? NaN : Number(text);
    if (!Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value)) throw new Error(field.type === "integer" ? "Enter a whole number." : "Enter a finite number.");
    return value;
  }
  if (question.numbered) {
    if (question.custom && text.startsWith("text:")) return question.multiple ? [text.slice(5)] : text.slice(5);
    if (!text.trim() && question.multiple) return [];
    const indices = text.split(",").map(value => value.trim());
    if ((!question.multiple && indices.length !== 1) || indices.some(value => !/^[1-9]\d*$/u.test(value) || !question.options[Number(value) - 1])) throw new Error("Enter the choice number, or comma-separated numbers for multiple choices.");
    const values = [...new Set(indices.map(value => {
      const option = question.options[Number(value) - 1];
      return typeof option === "string" ? option : option.value ?? option.label;
    }))];
    return question.multiple ? values : values[0];
  }
  return question.multiple ? [text] : text;
}
