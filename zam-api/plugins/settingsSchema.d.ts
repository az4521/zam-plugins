/**
 * Pure logic for plugin settings schemas: field types, schema validation, and
 * value coercion. Validates that a third-party plugin's settings schema is
 * well-formed (no nested lists, select has options, unique keys) and coerces
 * stored user values to the schema's types with defaults. Pure — no SDK, DOM,
 * or localStorage imports.
 */
export interface ToggleField {
    key: string;
    type: "toggle";
    label: string;
    default?: boolean;
    description?: string;
}
export interface TextField {
    key: string;
    type: "text";
    label: string;
    default?: string;
    placeholder?: string;
    description?: string;
}
export interface NumberField {
    key: string;
    type: "number";
    label: string;
    default?: number;
    min?: number;
    max?: number;
    step?: number;
    description?: string;
}
export interface SelectField {
    key: string;
    type: "select";
    label: string;
    default?: string;
    options: {
        value: string;
        label: string;
    }[];
    description?: string;
}
export type ScalarField = ToggleField | TextField | NumberField | SelectField;
export interface ListField {
    key: string;
    type: "list";
    label: string;
    fields: ScalarField[];
    default?: Record<string, unknown>[];
    description?: string;
}
export type SettingsField = ScalarField | ListField;
export type SettingsSchema = SettingsField[];
/** Validates a settings schema. Never throws; collects all errors. */
export declare function validateSchema(schema: unknown): {
    valid: boolean;
    errors: string[];
};
/** Coerces stored values to match the schema. Never throws; falls back to
 *  defaults then type-zero. Idempotent. */
export declare function coerceValues(schema: SettingsSchema, stored: unknown): Record<string, unknown>;
