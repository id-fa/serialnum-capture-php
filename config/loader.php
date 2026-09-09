<?php
/**
 * 設定の読み込み（仕組みの部分・通常は編集不要）
 * ============================================================
 * config/default.php を土台に、config/<プロジェクトID>.php があれば
 * その内容を重ねて（差分だけ上書きして）返します。
 *
 *   config/default.php    共通設定 … すべてのプロジェクトの土台
 *   config/PRJ-0001.php   差分のみ … 書いた項目だけ default を上書き
 *   config/PRJ-0002.php   差分のみ
 *
 * 使い方:
 *   require __DIR__ . '/../config/loader.php';
 *   $config = inspection_load_config($projectId);   // null なら既定プロジェクト
 * ============================================================
 */

declare(strict_types=1);

/**
 * プロジェクトIDとして受け付けてよい形か。
 *
 * このIDはそのまま設定ファイル名と保存フォルダ名になるため、
 * ディレクトリ移動に使える文字を一切通さない。
 */
function inspection_valid_project_id(?string $id): bool
{
    if ($id === null || $id === '' || strlen($id) > 64) {
        return false;
    }
    // 英数字と . _ - のみ
    if (!preg_match('/\A[0-9A-Za-z._-]+\z/', $id)) {
        return false;
    }
    // 「..」や先頭のドットは弾く（親ディレクトリ参照・隠しファイル対策）
    if (str_contains($id, '..') || str_starts_with($id, '.')) {
        return false;
    }
    // 土台のファイルと仕組みのファイルは選ばせない
    if (in_array(strtolower($id), ['default', 'loader'], true)) {
        return false;
    }
    return true;
}

/**
 * 配列を再帰的に重ねる。
 *
 * 連想配列は階層をたどってマージし、リスト（BARCODE.FORMATS など）は
 * 丸ごと置き換える。「一部だけ足す」より「その項目を宣言し直す」ほうが
 * 設定ファイルとして読みやすいため。
 */
function inspection_merge_config(array $base, array $override): array
{
    foreach ($override as $key => $value) {
        if (
            is_array($value)
            && isset($base[$key])
            && is_array($base[$key])
            && !array_is_list($value)
            && !array_is_list($base[$key])
        ) {
            $base[$key] = inspection_merge_config($base[$key], $value);
        } else {
            $base[$key] = $value;
        }
    }
    return $base;
}

/** プロジェクト別設定ファイルのパス（妥当なIDのときのみ） */
function inspection_project_config_path(string $id): ?string
{
    if (!inspection_valid_project_id($id)) {
        return null;
    }
    $path = __DIR__ . DIRECTORY_SEPARATOR . $id . '.php';
    return is_file($path) ? $path : null;
}

/**
 * 定義済みプロジェクトの一覧を返す。
 *
 * @return array<int, array{id: string, label: string}> 画面の切り替えUIに使う
 */
function inspection_list_projects(): array
{
    $defaults = require __DIR__ . '/default.php';
    $projects = [];

    foreach (glob(__DIR__ . '/*.php') ?: [] as $file) {
        $id = basename($file, '.php');
        if (!inspection_valid_project_id($id)) {
            continue;   // default.php / loader.php はここで除外される
        }
        $override = require $file;
        if (!is_array($override)) {
            continue;
        }
        $projects[] = [
            'id'    => $id,
            'label' => (string)($override['PROJECT_LABEL'] ?? $defaults['PROJECT_LABEL'] ?? $id),
        ];
    }

    // 既定プロジェクトに専用ファイルが無い場合も一覧に載せる
    $defaultId = (string)($defaults['PROJECT_ID'] ?? '');
    if ($defaultId !== '' && !in_array($defaultId, array_column($projects, 'id'), true)) {
        array_unshift($projects, [
            'id'    => $defaultId,
            'label' => (string)($defaults['PROJECT_LABEL'] ?? $defaultId),
        ]);
    }

    usort($projects, static fn($a, $b) => strcmp($a['id'], $b['id']));
    return $projects;
}

/**
 * 設定を読み込む。
 *
 * @param string|null $projectId 切り替えたいプロジェクトID。
 *                               null / 不正 / 対応ファイルなし の場合は
 *                               config/default.php の内容をそのまま返す。
 */
function inspection_load_config(?string $projectId = null): array
{
    $config = require __DIR__ . '/default.php';

    // 指定が無ければ default.php の PROJECT_ID を使う。
    // これにより既定プロジェクトでも専用ファイルが適用される。
    $id = ($projectId !== null && $projectId !== '')
        ? $projectId
        : (string)($config['PROJECT_ID'] ?? '');

    $path = $id !== '' ? inspection_project_config_path($id) : null;

    if ($path !== null) {
        $override = require $path;
        if (is_array($override)) {
            $config = inspection_merge_config($config, $override);
        }
        // 実際に読み込めたときだけ ID を確定させる
        $config['PROJECT_ID'] = $id;
    }
    // 対応ファイルが無いIDを渡された場合は、既定プロジェクトのまま返す

    return $config;
}
