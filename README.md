# Config Pilot

پنل مدیریت کانفیگ روی Cloudflare Workers با ذخیره‌سازی در KV و اتصال به تلگرام.

## کپی کانفیگ بین کاربران

- هنگام ایجاد کاربر، انتخاب «کپی کانفیگ از کاربر دیگر» اختیاری است. بدون انتخاب منبع، کاربر با کانفیگ خالی ساخته می‌شود.
- در صفحهٔ کانفیگ هر کاربر، یک کاربر دیگر را انتخاب کنید و «کپی کانفیگ‌ها» را بزنید. پس از تأیید، کانفیگ منبع جایگزین کانفیگ مقصد می‌شود و کانفیگ قبلی مقصد از طریق «بازیابی بکاپ» قابل بازگرداندن است.
- کپی مستقل است: تغییرات بعدی کاربران روی یکدیگر اثر ندارد. شناسه، نام، توکن و وضعیت کاربران کپی نمی‌شود. کاربر منبع باید کانفیگ غیرخالی داشته باشد.

## زبان و ظاهر

دکمه‌های بالای صفحهٔ ورود و پنل، زبان فارسی/انگلیسی و تم روشن/تاریک را تغییر می‌دهند. زبان انگلیسی چپ‌به‌راست است و متن کانفیگ‌ها و لینک‌ها همیشه چپ‌به‌راست می‌مانند. زبان و تم در مرورگر ذخیره می‌شوند. در تم روشن دکمهٔ ماه و در تم تاریک دکمهٔ خورشید نمایش داده می‌شود. این تنظیمات در مینی‌اپ تلگرام هم در دسترس‌اند.

## زبان ربات تلگرام

در منوی ربات دکمهٔ «🌐 زبان / Language» را بزنید یا دستور `/language` را ارسال کنید و فارسی یا English را انتخاب کنید. دستورهای `/language fa` و `/language en` نیز زبان را مستقیم تغییر می‌دهند.

پیام‌ها، دکمه‌ها، راهنما، پیام تست و توضیح دستورهای ربات با زبان انتخاب‌شده نمایش داده می‌شوند. انتخاب زبان در KV برای ادمین ذخیره می‌شود و مستقل از زبان پنل است. تغییر زبان، عملیات نیمه‌تمام را لغو نمی‌کند و نام کاربران و محتوای کانفیگ‌ها را تغییر نمی‌دهد. دکمه‌های قدیمی فارسی و انگلیسی نیز همچنان قابل استفاده‌اند.

## Development

Requires a current Node.js version supported by Wrangler.

```sh
npm install
npm test
npx wrangler dev --local
npx wrangler deploy --dry-run
```

Configure the `CONFIGS_KV` binding in `wrangler.toml` before deploying with `npm run deploy`.

Authenticated API additions:

- `POST /api/admin/users/create`: accepts optional `sourceUserId` alongside `name`.
- `POST /api/admin/users/configs/copy`: accepts destination `id` and `sourceUserId`; preserves an existing destination backup through the regular config-save flow.

Both paths preserve the source config text, enforce the 5 MB limit, and reject missing or empty source users before writing destination records. Copying a user to itself is rejected.
