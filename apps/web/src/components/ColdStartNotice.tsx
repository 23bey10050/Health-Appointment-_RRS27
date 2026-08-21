import { useDelayedLoading } from '../lib/useDelayedLoading.js';

/**
 * Shown only once a request has genuinely been pending a while - see `useDelayedLoading` for why
 * the threshold matters. The wording says what is actually true (a free-tier server that went to
 * sleep takes half a minute or so to answer its first request) rather than a generic spinner that
 * leaves a visitor wondering whether anything is happening at all.
 */
export function ColdStartNotice({ isLoading }: { isLoading: boolean }) {
  const show = useDelayedLoading(isLoading);

  if (!show) {
    return null;
  }

  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-md border border-slate-200 bg-white px-6 py-8 text-center"
    >
      <span
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
      />
      <p className="text-sm text-slate-600">
        Waking up the clinic&apos;s servers&hellip; this can take up to a minute on the first
        request of the day.
      </p>
    </div>
  );
}
