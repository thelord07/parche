import type { Transporter } from 'nodemailer';

export interface MailerOptions {
  from: string;
  publicUrl: string;
}

export interface Mailer {
  sendMagicLink(opts: { to: string; token: string }): Promise<void>;
}

/**
 * Create a mailer bound to a nodemailer transport.
 * The logger is kept off; URL, html, and text are never logged or printed.
 */
export function createMailer(transport: Transporter, options: MailerOptions): Mailer {
  const { from, publicUrl } = options;

  return {
    async sendMagicLink({ to, token }) {
      const url = `${publicUrl}/auth#${token}`;
      const html = `<p>Haz click en el botón para entrar a parche:</p><p><a href="${url}">Entrar a parche</a></p><p>Este link vence en 15 minutos y solo se puede usar una vez.</p>`;
      const text = `Entra a parche: ${url}\n\nEste link vence en 15 minutos y solo se puede usar una vez.`;

      await transport.sendMail({
        from,
        to,
        subject: 'Entra a parche',
        html,
        text,
      });
    },
  };
}
