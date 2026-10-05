import { assertRemoteToolJson } from "./remote-tool-wire.js";

/** Supports primitive/union types, enum/const, object properties/required/additionalProperties,
 * array items/uniqueItems, numeric and size bounds, and boolean/composition schemas.
 * References, patterns, formats, tuple dialects and every other assertion fail closed.
 */
export function validateRemoteToolArguments(
  schema: unknown,
  value: unknown,
): boolean {
  const reason = unsupportedRemoteToolSchema(schema);
  if (reason !== undefined) throw new TypeError(reason);
  assertRemoteToolJson(value, 48 * 1024);
  return validSchema(schema, value);
}

/** Honest bounded schema subset: unknown assertions are never silently ignored. */
export function unsupportedRemoteToolSchema(
  schema: unknown,
): string | undefined {
  try {
    assertRemoteToolJson(schema, 48 * 1024);
    checkSchema(schema, { nodes: 0 }, 0);
    return undefined;
  } catch (error) {
    return `Remote execution requires a supported exact JSON schema: ${error instanceof Error ? error.message : "unsupported schema"}`;
  }
}
const SCHEMA_KEYS = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);
const TYPES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
function checkSchema(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): void {
  if (++budget.nodes > 1024 || depth > 16)
    throw new Error("schema complexity exceeds limit");
  if (typeof value === "boolean") return;
  if (!isRecord(value)) throw new Error("schema must be an object or boolean");
  for (const key of Object.keys(value))
    if (!SCHEMA_KEYS.has(key)) throw new Error(`unsupported keyword ${key}`);
  if (
    value.$schema !== undefined &&
    ![
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2020-12/schema",
    ].includes(String(value.$schema))
  )
    throw new Error("unsupported schema dialect");
  for (const key of ["$comment", "title", "description"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`invalid ${key}`);
  for (const key of ["deprecated", "readOnly", "writeOnly"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`invalid ${key}`);
  if (value.examples !== undefined && !Array.isArray(value.examples))
    throw new Error("invalid examples");
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (
      types.length === 0 ||
      new Set(types).size !== types.length ||
      types.some((type) => typeof type !== "string" || !TYPES.has(type))
    )
      throw new Error("invalid type");
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      value.enum.length > 256 ||
      new Set(value.enum.map(canonical)).size !== value.enum.length)
  )
    throw new Error("invalid enum");
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) throw new Error("invalid properties");
    for (const property of Object.values(value.properties))
      checkSchema(property, budget, depth + 1);
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.some((key) => typeof key !== "string") ||
      new Set(value.required).size !== value.required.length)
  )
    throw new Error("invalid required");
  if (value.additionalProperties !== undefined)
    checkSchema(value.additionalProperties, budget, depth + 1);
  if (value.items !== undefined) checkSchema(value.items, budget, depth + 1);
  for (const key of [
    "minProperties",
    "maxProperties",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
  ])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 0)
    )
      throw new Error(`invalid ${key}`);
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      throw new Error(`invalid ${key}`);
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean")
    throw new Error("invalid uniqueItems");
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (value[key] !== undefined) {
      if (
        !Array.isArray(value[key]) ||
        value[key].length === 0 ||
        value[key].length > 16
      )
        throw new Error(`invalid ${key}`);
      for (const branch of value[key]) checkSchema(branch, budget, depth + 1);
    }
  if (value.not !== undefined) checkSchema(value.not, budget, depth + 1);
}
function validSchema(schema: unknown, value: unknown): boolean {
  if (typeof schema === "boolean") return schema;
  const data = schema as Record<string, unknown>;
  if (
    data.type !== undefined &&
    !(Array.isArray(data.type) ? data.type : [data.type]).some((type) =>
      matchesType(String(type), value),
    )
  )
    return false;
  if (
    Object.hasOwn(data, "const") &&
    canonical(data.const) !== canonical(value)
  )
    return false;
  if (
    Array.isArray(data.enum) &&
    !data.enum.some((entry) => canonical(entry) === canonical(value))
  )
    return false;
  if (
    Array.isArray(data.anyOf) &&
    !data.anyOf.some((branch) => validSchema(branch, value))
  )
    return false;
  if (
    Array.isArray(data.oneOf) &&
    data.oneOf.filter((branch) => validSchema(branch, value)).length !== 1
  )
    return false;
  if (
    Array.isArray(data.allOf) &&
    !data.allOf.every((branch) => validSchema(branch, value))
  )
    return false;
  if (data.not !== undefined && validSchema(data.not, value)) return false;
  if (typeof value === "number") {
    if (typeof data.minimum === "number" && value < data.minimum) return false;
    if (typeof data.maximum === "number" && value > data.maximum) return false;
    if (
      typeof data.exclusiveMinimum === "number" &&
      value <= data.exclusiveMinimum
    )
      return false;
    if (
      typeof data.exclusiveMaximum === "number" &&
      value >= data.exclusiveMaximum
    )
      return false;
  }
  if (
    typeof value === "string" &&
    !bounded([...value].length, data.minLength, data.maxLength)
  )
    return false;
  if (Array.isArray(value)) {
    if (!bounded(value.length, data.minItems, data.maxItems)) return false;
    if (
      data.uniqueItems === true &&
      new Set(value.map(canonical)).size !== value.length
    )
      return false;
    if (
      data.items !== undefined &&
      !value.every((entry) => validSchema(data.items, entry))
    )
      return false;
  }
  if (isRecord(value)) {
    if (
      !bounded(
        Object.keys(value).length,
        data.minProperties,
        data.maxProperties,
      )
    )
      return false;
    if (
      Array.isArray(data.required) &&
      data.required.some((key) => !Object.hasOwn(value, String(key)))
    )
      return false;
    const properties = isRecord(data.properties) ? data.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!validSchema(properties[key], child)) return false;
      } else if (
        data.additionalProperties === false ||
        (isRecord(data.additionalProperties) &&
          !validSchema(data.additionalProperties, child))
      )
        return false;
    }
  }
  return true;
}
function matchesType(type: string, value: unknown): boolean {
  return type === "null"
    ? value === null
    : type === "object"
      ? isRecord(value)
      : type === "array"
        ? Array.isArray(value)
        : type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : typeof value === type;
}
function bounded(value: number, min: unknown, max: unknown): boolean {
  return (
    !(typeof min === "number" && value < min) &&
    !(typeof max === "number" && value > max)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
