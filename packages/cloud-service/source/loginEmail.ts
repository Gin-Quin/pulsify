const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (character) => {
		return {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}[character]!;
	});

/** Inline styles and presentation tables keep the email independent of website CSS. */
export function loginEmail(link: string, code: string, dashboardUrl: string) {
	const href = escapeHtml(link);
	const signInCode = escapeHtml(code);
	const logo = escapeHtml(new URL("/logo-84.png", dashboardUrl).href);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Your Pulsify Cloud sign-in code</title>
</head>
<body style="margin:0;padding:0;background-color:#030d14;color:#e8f6f8;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
	<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Your sign-in code is ${signInCode}. Valid for 15 minutes.</div>
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#030d14" style="background-color:#030d14;">
		<tr>
			<td align="center" style="padding:40px 16px;">
				<!--[if mso]><table role="presentation" width="520" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:520px;">
					<tr>
						<td style="padding:0 8px 24px;">
							<table role="presentation" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td width="42" valign="middle"><img src="${logo}" width="42" height="42" alt="" style="display:block;border:0;"></td>
									<td valign="middle" style="padding-left:12px;color:#e8f6f8;font-size:20px;line-height:28px;font-weight:700;">Pulsify <span style="color:#8fb2ba;font-weight:400;">Cloud</span></td>
								</tr>
							</table>
						</td>
					</tr>
					<tr>
						<td bgcolor="#06161f" style="padding:32px 24px;background-color:#06161f;border:1px solid #16434a;border-radius:20px;">
							<p style="margin:0 0 12px;color:#3df5e0;font-size:12px;line-height:18px;font-weight:700;letter-spacing:2px;">YOUR WORKSPACE AWAITS</p>
							<h1 style="margin:0 0 16px;color:#e8f6f8;font-size:28px;line-height:36px;font-weight:700;">Sign in to Pulsify Cloud</h1>
							<p style="margin:0 0 24px;color:#8fb2ba;font-size:16px;line-height:26px;">Enter this code on the sign-in page to get back to your dashboard.</p>
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td align="center" bgcolor="#030d14" style="padding:20px 8px;background-color:#030d14;border:1px solid #16434a;border-radius:12px;">
										<p style="margin:0;color:#3df5e0;font-family:'Courier New',Courier,monospace;font-size:36px;line-height:44px;font-weight:700;letter-spacing:8px;">${signInCode}</p>
									</td>
								</tr>
							</table>
							<p style="margin:24px 0 16px;color:#8fb2ba;font-size:15px;line-height:24px;">Or sign in directly with the button below.</p>
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td align="center" bgcolor="#3df5e0" style="background-color:#3df5e0;border-radius:8px;mso-padding-alt:16px 24px;">
										<a href="${href}" style="display:block;padding:16px 24px;border:1px solid #3df5e0;border-radius:8px;color:#032028;font-size:16px;line-height:22px;font-weight:700;text-align:center;text-decoration:none;">Open the dashboard</a>
									</td>
								</tr>
							</table>
							<p style="margin:24px 0 0;color:#8fb2ba;font-size:13px;line-height:21px;text-align:center;">Your code and sign-in link expire in 15 minutes.</p>
						</td>
					</tr>
					<tr>
						<td style="padding:24px 8px 0;">
							<p style="margin:0;color:#8fb2ba;font-size:13px;line-height:21px;">If you didn’t request this email, you can safely ignore it.</p>
							<p style="margin:16px 0 0;color:#8fb2ba;font-size:12px;line-height:20px;">Button not working? Copy and paste this link into your browser:</p>
							<p style="margin:4px 0 0;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere;"><a href="${href}" style="color:#3df5e0;text-decoration:underline;word-break:break-all;">${href}</a></p>
						</td>
					</tr>
				</table>
				<!--[if mso]></td></tr></table><![endif]-->
			</td>
		</tr>
	</table>
</body>
</html>`;
}
