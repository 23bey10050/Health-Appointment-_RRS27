import type { EmergencyInfo } from "@/components/voice/useVoiceSocket";
import { EMERGENCY_CATEGORY_LABEL } from "@/lib/emergencyCategories";

/** Full-width, non-dismissable per IMPLEMENTATION.md section 9.2/15 -- there is
 * deliberately no close button. It only goes away when the session ends. */
export function EmergencyBanner({ info }: { info: EmergencyInfo }) {
  const label = EMERGENCY_CATEGORY_LABEL[info.category] ?? "Medical emergency detected";

  return (
    <div className="w-full rounded-lg border-2 border-red-700 bg-red-600 p-5 text-white shadow-lg" role="alert">
      <p className="text-lg font-bold">{label}</p>
      <p className="mt-1 text-sm text-red-50">
        If this is a life-threatening emergency, call for help immediately. Do not wait for the
        assistant to finish speaking.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {info.numbers.map((number) => (
          <a
            key={number}
            href={`tel:${number}`}
            className="rounded-md bg-white px-5 py-2.5 text-lg font-bold text-red-700 shadow hover:bg-red-50"
          >
            Call {number}
          </a>
        ))}
      </div>
    </div>
  );
}
