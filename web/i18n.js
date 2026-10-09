// English / Spanish text for the shop view and the Log work form. Each device
// remembers its choice; the first visit follows the phone's language.

const TEXT = {
  en: {
    shopTitle: 'Trucks that need work',
    shopCount: (n) => (n === 1 ? '1 truck needs work' : `${n} trucks need work`),
    shopEmpty: 'Nothing is due right now.',
    anotherTruck: 'Log work on another truck…',
    admin: 'Admin',
    shopView: 'Shop view',
    outOfService: 'Out of service',
    overdue: 'Overdue',
    soon: 'Due soon',
    noRecord: 'no record yet',
    more: (n) => `+${n} more`,
    milesOverdue: (x) => `${x} mi overdue`,
    hoursOverdue: (x) => `${x} h overdue`,
    daysOverdue: (x) => `${x} days overdue`,
    inMiles: (x) => `in ${x} mi`,
    inHours: (x) => `in ${x} h`,
    inDays: (x) => `in ${x} days`,
    logWork: 'Log work',
    pickTruck: 'Pick the truck first.',
    truck: 'Truck',
    chooseTruck: 'Choose a truck…',
    dueHere: 'Due on this truck',
    dueHint: 'Tap each one you did.',
    whatDone: 'What was done?',
    jobs: {
      pm: ['PM', 'oil, fuel filters, grease, levels'],
      oilChange: ['Oil change', 'oil, fuel filters'],
      airFilter: ['Air filter'],
      airDryer: ['Air dryer'],
    },
    repairOther: 'Repair / other work',
    repair: 'Repair',
    repairPlaceholder: 'What was repaired? (for example: replaced A/C compressor)',
    cost: 'Cost ($)',
    optional: 'Optional',
    marksDone: 'This marks done',
    nothingOnSchedule: "Nothing on this truck's schedule. It will still be in the log.",
    tickAJob: 'Tick a job above, or add a service below.',
    addService: '+ Add another service…',
    miles: 'Miles',
    date: 'Date',
    today: 'Today',
    change: 'Change',
    fromSamsara: 'from Samsara',
    fromSamsaraFor: (d) => `from Samsara for ${d}`,
    noSamsaraFor: (d) => `No Samsara reading for ${d}. Type the miles.`,
    hours: 'Engine hours (optional)',
    note: 'Note',
    notePlaceholder: 'Shop or invoice # (optional)',
    loggedBy: 'Logged by',
    yourName: 'Your name',
    save: 'Save',
    saveCount: (n, truck) => `Save: ${n} ${n === 1 ? 'item' : 'items'} on ${truck}`,
    saving: 'Saving…',
    cancel: 'Cancel',
    close: 'Close',
    errTick: 'Tick what was done.',
    errRepair: 'Describe the repair.',
    errFuture: "The date can't be in the future.",
    errTooHigh: (x) => `That's more than the truck's current ${x} mi. Check the number.`,
    confirmSamsara: (truck, range, day, typed) => `Samsara shows ${truck} at ${range} mi around ${day}. You typed ${typed}. Save anyway?`,
    confirmOlder: (items, x) => `${items} already has a later service on record (${x} mi). Save this older one anyway?`,
    saved: (truck, what) => `Saved on ${truck}: ${what}`,
    repairWord: 'repair',
    couldNotSave: (m) => `Could not save: ${m}`,
    undo: 'Undo',
    undone: 'Undone.',
  },
  es: {
    shopTitle: 'Camiones que necesitan servicio',
    shopCount: (n) => (n === 1 ? '1 camión necesita servicio' : `${n} camiones necesitan servicio`),
    shopEmpty: 'No hay nada pendiente.',
    anotherTruck: 'Registrar trabajo en otro camión…',
    admin: 'Admin',
    shopView: 'Vista del taller',
    outOfService: 'Fuera de servicio',
    overdue: 'Vencido',
    soon: 'Pronto',
    noRecord: 'sin registro',
    more: (n) => `+${n} más`,
    milesOverdue: (x) => `vencido por ${x} mi`,
    hoursOverdue: (x) => `vencido por ${x} h`,
    daysOverdue: (x) => `vencido por ${x} días`,
    inMiles: (x) => `en ${x} mi`,
    inHours: (x) => `en ${x} h`,
    inDays: (x) => `en ${x} días`,
    logWork: 'Registrar trabajo',
    pickTruck: 'Primero elija el camión.',
    truck: 'Camión',
    chooseTruck: 'Elija un camión…',
    dueHere: 'Pendiente en este camión',
    dueHint: 'Toque cada uno que hizo.',
    whatDone: '¿Qué se hizo?',
    jobs: {
      pm: ['PM', 'aceite, filtros de diésel, engrase, niveles'],
      oilChange: ['Cambio de aceite', 'aceite, filtros de diésel'],
      airFilter: ['Filtro de aire'],
      airDryer: ['Secador de aire'],
    },
    repairOther: 'Reparación / otro trabajo',
    repair: 'Reparación',
    repairPlaceholder: '¿Qué se reparó? (por ejemplo: compresor de A/C nuevo)',
    cost: 'Costo ($)',
    optional: 'Opcional',
    marksDone: 'Esto marca como hecho',
    nothingOnSchedule: 'No está en el programa de este camión. Quedará en el registro.',
    tickAJob: 'Marque un trabajo arriba o agregue un servicio abajo.',
    addService: '+ Agregar otro servicio…',
    miles: 'Millas',
    date: 'Fecha',
    today: 'Hoy',
    change: 'Cambiar',
    fromSamsara: 'de Samsara',
    fromSamsaraFor: (d) => `de Samsara para ${d}`,
    noSamsaraFor: (d) => `Samsara no tiene lectura para ${d}. Escriba las millas.`,
    hours: 'Horas de motor (opcional)',
    note: 'Nota',
    notePlaceholder: 'Taller o # de factura (opcional)',
    loggedBy: 'Registrado por',
    yourName: 'Su nombre',
    save: 'Guardar',
    saveCount: (n, truck) => `Guardar: ${n} ${n === 1 ? 'servicio' : 'servicios'} en ${truck}`,
    saving: 'Guardando…',
    cancel: 'Cancelar',
    close: 'Cerrar',
    errTick: 'Marque lo que se hizo.',
    errRepair: 'Describa la reparación.',
    errFuture: 'La fecha no puede ser en el futuro.',
    errTooHigh: (x) => `Es más que las ${x} mi actuales del camión. Revise el número.`,
    confirmSamsara: (truck, range, day, typed) => `Samsara muestra ${truck} con ${range} mi alrededor del ${day}. Usted escribió ${typed}. ¿Guardar de todos modos?`,
    confirmOlder: (items, x) => `${items} ya tiene un servicio más reciente (${x} mi). ¿Guardar este más antiguo de todos modos?`,
    saved: (truck, what) => `Guardado en ${truck}: ${what}`,
    repairWord: 'reparación',
    couldNotSave: (m) => `No se pudo guardar: ${m}`,
    undo: 'Deshacer',
    undone: 'Deshecho.',
  },
};

const KEY = 'aslog.lang';
let lang = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch { /* storage blocked */ }
  return (navigator.language ?? '').toLowerCase().startsWith('es') ? 'es' : 'en';
})();

export const getLang = () => lang;
export function setLang(next) {
  lang = next === 'es' ? 'es' : 'en';
  try { localStorage.setItem(KEY, lang); } catch { /* not remembered */ }
  document.documentElement.lang = lang;
}
document.documentElement.lang = lang;

// t('key') or t('key', ...args) for the text functions above.
export function t(key, ...args) {
  const v = TEXT[lang][key] ?? TEXT.en[key];
  return typeof v === 'function' ? v(...args) : v;
}

// A date in the current language: "Oct 2, 2026" / "2 oct 2026".
export function dateText(value) {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
