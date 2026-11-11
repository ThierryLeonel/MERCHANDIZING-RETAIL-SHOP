import { registerDecorator, ValidationOptions } from "class-validator";

/** Accepts a decimal as number or numeric string; optional bounds. Never parsed to float for arithmetic. */
export function IsDecimalValue(opts: { min?: number; positive?: boolean; maxDecimals?: number } = {}, vo?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isDecimalValue",
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be a decimal number${opts.positive ? " greater than zero" : opts.min != null ? ` >= ${opts.min}` : ""}`, ...vo },
      validator: {
        validate(value: unknown) {
          if (typeof value !== "string" && typeof value !== "number") return false;
          const s = String(value).trim();
          if (!/^-?\d+(\.\d+)?$/.test(s)) return false;
          const decs = s.includes(".") ? s.split(".")[1].length : 0;
          if (decs > (opts.maxDecimals ?? 6)) return false;
          const neg = s.startsWith("-");
          const isZero = /^-?0+(\.0+)?$/.test(s);
          if (opts.positive && (neg || isZero)) return false;
          if (opts.min === 0 && neg && !isZero) return false;
          return true;
        },
      },
    });
  };
}
