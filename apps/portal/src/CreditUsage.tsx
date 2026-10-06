import type { TokenUsage } from "./api";
import "./credit-usage.css";
export const creditNumber = (n: number) =>
  new Intl.NumberFormat("ru", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
export const tokenNumber = (n: number) => new Intl.NumberFormat("ru").format(n);
export default function CreditUsage({ usage }: { usage?: TokenUsage }) {
  if (!usage) return null;
  const rows = [
    {
      label: "Новый вход",
      count: usage.inputTokens + usage.cacheWriteTokens,
      cost: usage.inputCredits,
      tone: "input",
    },
    {
      label: "Кэш входа",
      count: usage.cacheReadTokens,
      cost: usage.cacheCredits,
      tone: "cache",
    },
    {
      label: "Выход модели",
      count: usage.outputTokens,
      cost: usage.outputCredits,
      tone: "output",
    },
  ];
  const total = rows.reduce((n, r) => n + r.cost, 0);
  return (
    <div className="credit-usage">
      <div className="credit-usage-head">
        <b>Расход за неделю</b>
        <span>кредиты</span>
      </div>
      {rows.map((r) => (
        <div className={"credit-usage-row " + r.tone} key={r.tone}>
          <div>
            <span>
              <i />
              {r.label}
            </span>
            <b>{creditNumber(r.cost)}</b>
          </div>
          <small>
            {tokenNumber(r.count)} токенов
            {total > 0
              ? " · " +
                new Intl.NumberFormat("ru", {
                  maximumFractionDigits: 1,
                }).format((100 * r.cost) / total) +
                "% стоимости"
              : ""}
          </small>
          <div className="credit-usage-track">
            <span
              style={{ width: total > 0 ? (100 * r.cost) / total + "%" : "0%" }}
            />
          </div>
        </div>
      ))}
      <p>
        Кэш:{" "}
        <b>
          {new Intl.NumberFormat("ru", { maximumFractionDigits: 2 }).format(
            usage.cacheOfInputPercent,
          )}
          %
        </b>{" "}
        входных токенов.
      </p>
      <small className="credit-usage-note">
        По тарифам DeepSeek: кэш дешевле нового входа, в часы пик стоимость
        выше. Рассуждения входят в выход модели.
      </small>
    </div>
  );
}
