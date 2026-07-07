/**
 * Outbound email via Resend. Without RESEND_API_KEY (dev), emails are
 * printed to the server log instead — same content, zero setup.
 */

export interface EmailArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(args: EmailArgs): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `\n[email dev-preview] to=${args.to}\n[email dev-preview] subject=${args.subject}\n${args.text}\n`,
    );
    return false;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "deepblue <onboarding@resend.dev>",
      to: [args.to],
      subject: args.subject,
      text: args.text,
      html: args.html,
    }),
  });
  if (!res.ok) {
    console.error(`email send failed: HTTP ${res.status}`, await res.text());
    return false;
  }
  return true;
}
