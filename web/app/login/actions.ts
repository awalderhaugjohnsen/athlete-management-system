"use server";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCookieLanguage } from "@/lib/i18n/getServerLanguage";
import { dictionaries } from "@/lib/i18n/dictionaries";

function createAuthClient() {
  return (async () => {
    const cookieStore = await cookies();
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (cookiesToSet) => {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );
  })();
}

export async function signIn(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const t = dictionaries[await getCookieLanguage()].auth;
    redirect(`/login?error=${encodeURIComponent(t.errors.invalidCredentials)}`);
  }

  redirect("/");
}

export async function signUp(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/setup`,
    },
  });

  if (error) {
    redirect("/login?mode=signup&error=" + encodeURIComponent(error.message));
  }

  const t = dictionaries[await getCookieLanguage()].auth;
  redirect(`/login?mode=signup&message=${encodeURIComponent(t.errors.checkEmailToConfirm)}`);
}

export async function signOut() {
  const supabase = await createAuthClient();
  await supabase.auth.signOut();
  redirect("/login");
}
