<?php
/**
 * 設定の読み込み（仕組みの部分・通常は編集不要）
 * ============================================================
 * config/default.php を土台に、config/local.php（あれば）と
 * config/<プロジェクトID>.php（あれば）をこの順に重ねて
 * （差分だけ上書きして）返します。
 *
 *   config/default.php    共通設定 … すべてのプロジェクトの土台（Git 管理）
 *   config/local.php      設置先の差分 … default.php を触らずに土台を書き換える（Git 管理外）
 *   config/PRJ-0001.php   差分のみ … 書いた項目だけ土台を上書き
 *   config/PRJ-0002.php   差分のみ
 *
 * 使い方:
 *   require __DIR__ . '/../config/loader.php';
 *   $config = inspection_load_config($projectId);   // null なら既定プロジェクト
 * ============================================================
 */

declare(strict_types=1);

/**
 * 切り替えプルダウンに載せるかどうかの項目名。
 *
 * この項目だけは「書いたファイルの分にしか効かない」。
 * default.php（+ local.php）に書けば既定プロジェクトの表示だけを、
 * config/<ID>.php に書けばそのプロジェクトの表示だけを決める。
 * 土台からプロジェクトへは継承させず、読み込み結果からも取り除く。
 */
const INSPECTION_SHOW_IN_SELECT = 'SHOW_IN_SELECT';

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
    if (in_array(strtolower($id), ['default', 'local', 'loader'], true)) {
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

/**
 * 土台の設定（default.php に local.php を重ねたもの）。
 *
 * local.php は設置先ごとの差分を置く場所で Git 管理外。
 * 既定プロジェクトのIDや SERVER の上限値など「default.php を直接
 * 書き換えたくなる項目」をここで上書きできる。
 */
function inspection_base_config(): array
{
    $config = require __DIR__ . '/default.php';
    if (!is_array($config)) {
        $config = [];
    }

    $localPath = __DIR__ . DIRECTORY_SEPARATOR . 'local.php';
    if (is_file($localPath)) {
        $local = require $localPath;
        if (is_array($local)) {
            $config = inspection_merge_config($config, $local);
        }
    }
    return $config;
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

/** 設定配列の SHOW_IN_SELECT を読む（未指定は true） */
function inspection_show_in_select(array $config): bool
{
    return ($config[INSPECTION_SHOW_IN_SELECT] ?? true) !== false;
}

/**
 * 切り替えプルダウンに載せるプロジェクトの一覧を返す。
 *
 * 載るもの:
 *   - config/<ID>.php があるプロジェクト（そのファイルの SHOW_IN_SELECT が false なら除く）
 *   - 既定プロジェクト（土台の PROJECT_ID）。専用ファイルが無くても載る。
 *     土台の SHOW_IN_SELECT が false なら、専用ファイルの有無にかかわらず除く
 *   - SERVER.ALLOWED_PROJECT_IDS が設定されていれば、そこにあるものだけ
 *     （送信できないプロジェクトを選ばせても意味がないため）
 *
 * @return array<int, array{id: string, label: string}>
 */
function inspection_list_projects(): array
{
    $base        = inspection_base_config();
    $defaultId   = (string)($base['PROJECT_ID'] ?? '');
    $showDefault = inspection_show_in_select($base);
    $allowed     = $base['SERVER']['ALLOWED_PROJECT_IDS'] ?? [];
    $allowed     = is_array($allowed) ? array_map('strval', $allowed) : [];

    $projects = [];

    foreach (glob(__DIR__ . '/*.php') ?: [] as $file) {
        $id = basename($file, '.php');
        if (!inspection_valid_project_id($id)) {
            continue;   // default.php / local.php / loader.php はここで除外される
        }
        $override = require $file;
        if (!is_array($override)) {
            continue;
        }
        // 表示可否はそのファイル自身の分だけを見る（土台からは継承しない）
        if (!inspection_show_in_select($override)) {
            continue;
        }
        // 既定プロジェクトは土台側の指定にも従う
        if ($id === $defaultId && !$showDefault) {
            continue;
        }
        $projects[] = [
            'id'    => $id,
            'label' => (string)($override['PROJECT_LABEL'] ?? $base['PROJECT_LABEL'] ?? $id),
        ];
    }

    // 既定プロジェクトに専用ファイルが無い場合も一覧に載せる
    if ($defaultId !== '' && $showDefault
        && !in_array($defaultId, array_column($projects, 'id'), true)) {
        array_unshift($projects, [
            'id'    => $defaultId,
            'label' => (string)($base['PROJECT_LABEL'] ?? $defaultId),
        ]);
    }

    if ($allowed) {
        $projects = array_values(array_filter(
            $projects,
            static fn($p) => in_array($p['id'], $allowed, true)
        ));
    }

    usort($projects, static fn($a, $b) => strcmp($a['id'], $b['id']));
    return $projects;
}

/**
 * 設定を読み込む。
 *
 * @param string|null $projectId 切り替えたいプロジェクトID。
 *                               null / 不正 / 対応ファイルなし の場合は
 *                               土台（default.php + local.php）の内容をそのまま返す。
 */
function inspection_load_config(?string $projectId = null): array
{
    $config = inspection_base_config();

    // 指定が無ければ土台の PROJECT_ID を使う。
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

    // 一覧表示の可否は inspection_list_projects() がファイル単位で見る。
    // 動作設定には関係ないので、継承させないためにも取り除いておく
    unset($config[INSPECTION_SHOW_IN_SELECT]);

    return $config;
}
