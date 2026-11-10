const numericTarget = value => {
  const parsed = Number(String(value ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function classifyDailyResult(profile, metrics) {
  const target = numericTarget(profile?.target_value);
  const spend = Number(metrics?.spend || 0);
  const conversions = Number(metrics?.conversions || 0);
  const cpa = conversions > 0 ? spend / conversions : null;
  let status = 'ok';
  let findings = 'Критических отклонений по данным Direct не обнаружено.';
  let actions = 'Сохранить текущую структуру и продолжить наблюдение.';

  if (!target) {
    status = 'attention';
    findings = 'Целевое значение KPI не удалось преобразовать в число.';
    actions = 'Уточнить целевой KPI в паспорте результата.';
  } else if (['cpl', 'cpa'].includes(profile?.primary_kpi)) {
    if (!conversions && spend >= target * 2) {
      status = 'critical';
      findings = `Нет конверсий при расходе ${spend.toFixed(2)} ₽ — превышено два целевых CPA/CPL.`;
      actions = 'Проверить цели Метрики и CRM, поисковые запросы, площадки и приостановить подтверждённые источники пустого расхода.';
    } else if (!conversions && spend > 0) {
      status = 'attention';
      findings = `Есть расход ${spend.toFixed(2)} ₽, но конверсии не зафиксированы.`;
      actions = 'Проверить атрибуцию и накопить данные до одного целевого CPA/CPL без резких изменений стратегии.';
    } else if (cpa > target * 1.5) {
      status = 'critical';
      findings = `Фактический CPA/CPL ${cpa.toFixed(2)} ₽ выше цели ${target.toFixed(2)} ₽ более чем на 50%.`;
      actions = 'Разобрать запросы, аудитории и объявления; низкорисковые исключения оформить в журнал, стратегические изменения вынести на согласование.';
    } else if (cpa > target) {
      status = 'attention';
      findings = `Фактический CPA/CPL ${cpa.toFixed(2)} ₽ выше цели ${target.toFixed(2)} ₽.`;
      actions = 'Проверить расход по группам и запросам; не менять обучающуюся стратегию без достаточного объёма данных.';
    }
  }

  return { status, cpa, findings, actions };
}
