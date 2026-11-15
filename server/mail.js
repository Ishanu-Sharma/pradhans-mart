// Emails are composed here and kept in the outbox (db.outbox) until you connect a mail provider.
// Every marketing email carries a visible unsubscribe link and the RFC 8058 one-click headers.

export function composeWelcomeEmail({ business, baseUrl, email, unsubscribeToken }) {
  const unsubscribeUrl = new URL(`/unsubscribe?t=${encodeURIComponent(unsubscribeToken)}`, baseUrl).href;
  const text = [
    `You asked ${business.brandName} to email you about offers.`,
    '',
    'We send these emails only while you stay subscribed. We do not share your email address with anyone.',
    '',
    `Stop these emails: ${unsubscribeUrl}`,
    '',
    `${business.legalName || business.brandName}`,
    `${business.registeredAddress || ''}`.trim()
  ].join('\n');
  return {
    to: email,
    subject: `You are subscribed to ${business.brandName} offers`,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    },
    text,
    unsubscribeUrl
  };
}
