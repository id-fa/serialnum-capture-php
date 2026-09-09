@echo off
REM ============================================================
REM  検品ツール 開発用サーバー起動 (PHP built-in server)
REM
REM  [PC で確認する場合]
REM      http://localhost:8080/ をブラウザで開く
REM
REM  [スマホの実機で確認する場合]
REM      カメラは HTTPS でないと起動しないため、
REM      別のターミナルで Cloudflare Tunnel を起動すること。
REM
REM          cloudflared tunnel --url http://localhost:8080
REM
REM      表示された https://xxxx.trycloudflare.com をスマホで開く。
REM      URL は起動のたびに変わる。詳細は README.md の 3章を参照。
REM
REM  [停止]
REM      Ctrl+C
REM
REM  ※ このファイルは Shift_JIS で保存すること。
REM     UTF-8 で保存すると cmd が日本語を解釈できず、
REM     文字化けしたバイト列がコマンドとして実行されてしまう。
REM ============================================================

setlocal
set PORT=8080

php -S 0.0.0.0:%PORT% -t "%~dp0"

endlocal
