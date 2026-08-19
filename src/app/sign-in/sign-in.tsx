import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BifrostMark } from '@app/components/ui/bifrost-mark';
import { Button } from '@app/components/ui/button';
import { Google } from '@app/components/ui/svgs/google';
import { getSignInPolicy, type SignInPolicy } from '@app/api/bifrost';

const domainList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// Every line below is derived from the server's actual policy. The screen used
// to claim "For Northlight accounts only" while the server accepted any Google
// account, which is the one thing a sign-in screen must never do.
function describeAudience(policy: SignInPolicy | undefined): string | null {
  if (!policy) return null;
  if (!policy.isRestricted) return 'Any Google account can sign in.';
  if (policy.allowedDomains.length === 0) return 'Only invited accounts can sign in.';
  return `For ${domainList.format(policy.allowedDomains)} accounts only.`;
}

export default function SignIn(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const isDenied = searchParams.get('denied') === 'true';
  const { data: policy } = useQuery({ queryKey: ['sign-in-policy'], queryFn: getSignInPolicy });
  const audience = describeAudience(policy);
  const domains = policy?.allowedDomains ?? [];

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app-bg-primary px-5">
      <div className="flex w-full max-w-[360px] flex-col items-center text-center">
        <BifrostMark className="size-10" />
        <h1 className="mt-[18px] text-xl font-semibold tracking-[-0.01em]">Bifrost</h1>
        {isDenied ? (
          <>
            <p className="mt-2.5 text-[13.5px] leading-[1.55] text-app-text-tertiary text-pretty">
              {domains.length > 0
                ? `That account can't use Bifrost. Sign in with your ${domainList.format(domains)} account instead.`
                : "That account isn't on the list of people allowed to use Bifrost."}
            </p>
            <div className="mt-4 w-full rounded-[9px] border border-warning/30 bg-warning/7 px-3.5 py-3 text-left text-[12.5px] leading-5 text-app-text-secondary">
              {domains.length > 0 ? (
                <>Signed in with a personal account by mistake? Try again with your <span className="font-mono">@{domains[0]}</span> one. If you think you should have access, ask your Bifrost administrator.</>
              ) : (
                <>If you think you should have access, ask your Bifrost administrator to add your address.</>
              )}
            </div>
            <Button variant="outline" className="mt-3.5 w-full" onClick={() => setSearchParams({})}>Try another account</Button>
          </>
        ) : (
          <>
            <p className="mt-2.5 text-[13.5px] leading-[1.55] text-app-text-tertiary text-pretty">One sign-in for every tool your AI agents use. Your keys stay on the server — never on your laptop.</p>
            <Button asChild size="large" className="mt-[22px] w-full">
              <a href="/auth/google/start"><Google aria-hidden className="size-[15px]" />Continue with Google</a>
            </Button>
            {audience ? <div className="mt-3 text-[11.5px] text-app-text-quaternary">{audience}</div> : null}
          </>
        )}
      </div>
    </main>
  );
}
