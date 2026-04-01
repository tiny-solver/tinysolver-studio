use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lang {
    #[default]
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Es,
    De,
    Fr,
    Pt,
    Ar,
}

impl Lang {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "en" => Lang::En,
            "zh-cn" | "zh-CN" | "zh_CN" => Lang::ZhCn,
            "zh-tw" | "zh-TW" | "zh_TW" => Lang::ZhTw,
            "ja" => Lang::Ja,
            "ko" => Lang::Ko,
            "es" => Lang::Es,
            "de" => Lang::De,
            "fr" => Lang::Fr,
            "pt" => Lang::Pt,
            "ar" => Lang::Ar,
            _ => Lang::En,
        }
    }
}

// ── Event messages ──

pub fn turn_complete_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "会话完成",
        Lang::ZhTw => "對話完成",
        Lang::Ja => "セッション完了",
        Lang::Ko => "세션 완료",
        Lang::Es => "Sesión completada",
        Lang::De => "Sitzung abgeschlossen",
        Lang::Fr => "Session terminée",
        Lang::Pt => "Sessão concluída",
        Lang::Ar => "اكتملت الجلسة",
        Lang::En => "Turn Complete",
    }
}

pub fn turn_complete_body(lang: Lang, agent_type: &str) -> String {
    match lang {
        Lang::ZhCn => format!("{agent_type} 会话已完成"),
        Lang::ZhTw => format!("{agent_type} 對話已完成"),
        Lang::Ja => format!("{agent_type} セッションが完了しました"),
        Lang::Ko => format!("{agent_type} 세션이 완료되었습니다"),
        Lang::Es => format!("{agent_type} sesión completada"),
        Lang::De => format!("{agent_type} Sitzung abgeschlossen"),
        Lang::Fr => format!("Session {agent_type} terminée"),
        Lang::Pt => format!("Sessão {agent_type} concluída"),
        Lang::Ar => format!("اكتملت جلسة {agent_type}"),
        Lang::En => format!("{agent_type} session completed"),
    }
}

pub fn stop_reason_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "结束原因",
        Lang::ZhTw => "結束原因",
        Lang::Ja => "終了理由",
        Lang::Ko => "종료 사유",
        Lang::Es => "Motivo de fin",
        Lang::De => "Beendigungsgrund",
        Lang::Fr => "Raison de fin",
        Lang::Pt => "Motivo do término",
        Lang::Ar => "سبب الانتهاء",
        Lang::En => "Stop Reason",
    }
}

pub fn stop_reason_end_turn(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "正常结束",
        Lang::ZhTw => "正常結束",
        Lang::Ja => "正常終了",
        Lang::Ko => "정상 종료",
        Lang::Es => "Finalizado",
        Lang::De => "Normal beendet",
        Lang::Fr => "Terminé normalement",
        Lang::Pt => "Finalizado",
        Lang::Ar => "انتهى بشكل طبيعي",
        Lang::En => "Completed",
    }
}

pub fn stop_reason_cancelled(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "已取消",
        Lang::ZhTw => "已取消",
        Lang::Ja => "キャンセル",
        Lang::Ko => "취소됨",
        Lang::Es => "Cancelado",
        Lang::De => "Abgebrochen",
        Lang::Fr => "Annulé",
        Lang::Pt => "Cancelado",
        Lang::Ar => "تم الإلغاء",
        Lang::En => "Cancelled",
    }
}

pub fn agent_error_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "代理错误",
        Lang::ZhTw => "代理錯誤",
        Lang::Ja => "エージェントエラー",
        Lang::Ko => "에이전트 오류",
        Lang::Es => "Error del agente",
        Lang::De => "Agent-Fehler",
        Lang::Fr => "Erreur de l'agent",
        Lang::Pt => "Erro do agente",
        Lang::Ar => "خطأ في الوكيل",
        Lang::En => "Agent Error",
    }
}

pub fn agent_error_body(lang: Lang, agent_type: &str) -> String {
    match lang {
        Lang::ZhCn => format!("{agent_type} 发生错误"),
        Lang::ZhTw => format!("{agent_type} 發生錯誤"),
        Lang::Ja => format!("{agent_type} でエラーが発生しました"),
        Lang::Ko => format!("{agent_type}에서 오류 발생"),
        Lang::Es => format!("{agent_type} encontró un error"),
        Lang::De => format!("{agent_type} hat einen Fehler"),
        Lang::Fr => format!("{agent_type} a rencontré une erreur"),
        Lang::Pt => format!("{agent_type} encontrou um erro"),
        Lang::Ar => format!("حدث خطأ في {agent_type}"),
        Lang::En => format!("{agent_type} encountered an error"),
    }
}

pub fn error_message_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "错误信息",
        Lang::ZhTw => "錯誤訊息",
        Lang::Ja => "エラーメッセージ",
        Lang::Ko => "오류 메시지",
        Lang::Es => "Mensaje de error",
        Lang::De => "Fehlermeldung",
        Lang::Fr => "Message d'erreur",
        Lang::Pt => "Mensagem de erro",
        Lang::Ar => "رسالة الخطأ",
        Lang::En => "Error Message",
    }
}

// ── Daily report ──

pub fn daily_report_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "每日编码报告",
        Lang::ZhTw => "每日編碼報告",
        Lang::Ja => "日次コーディングレポート",
        Lang::Ko => "일일 코딩 보고서",
        Lang::Es => "Informe diario de codificación",
        Lang::De => "Täglicher Coding-Bericht",
        Lang::Fr => "Rapport de codage quotidien",
        Lang::Pt => "Relatório diário de codificação",
        Lang::Ar => "تقرير البرمجة اليومي",
        Lang::En => "Daily Coding Report",
    }
}

pub fn daily_report_summary(lang: Lang, date: &str) -> String {
    match lang {
        Lang::ZhCn => format!("今日编码活动汇总 ({date})"),
        Lang::ZhTw => format!("今日編碼活動匯總 ({date})"),
        Lang::Ja => format!("本日のコーディング活動まとめ ({date})"),
        Lang::Ko => format!("오늘의 코딩 활동 요약 ({date})"),
        Lang::Es => format!("Resumen de actividad de codificación ({date})"),
        Lang::De => format!("Coding-Aktivitätszusammenfassung ({date})"),
        Lang::Fr => format!("Résumé de l'activité de codage ({date})"),
        Lang::Pt => format!("Resumo da atividade de codificação ({date})"),
        Lang::Ar => format!("ملخص نشاط البرمجة ({date})"),
        Lang::En => format!("Daily coding activity summary ({date})"),
    }
}

pub fn total_sessions(lang: Lang, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("会话总数: {count}"),
        Lang::ZhTw => format!("對話總數: {count}"),
        Lang::Ja => format!("セッション合計: {count}"),
        Lang::Ko => format!("총 세션: {count}"),
        Lang::Es => format!("Total de sesiones: {count}"),
        Lang::De => format!("Sitzungen gesamt: {count}"),
        Lang::Fr => format!("Sessions totales : {count}"),
        Lang::Pt => format!("Total de sessões: {count}"),
        Lang::Ar => format!("إجمالي الجلسات: {count}"),
        Lang::En => format!("Total sessions: {count}"),
    }
}

pub fn by_agent_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "按代理分布:",
        Lang::ZhTw => "按代理分佈:",
        Lang::Ja => "エージェント別:",
        Lang::Ko => "에이전트별:",
        Lang::Es => "Por agente:",
        Lang::De => "Nach Agent:",
        Lang::Fr => "Par agent :",
        Lang::Pt => "Por agente:",
        Lang::Ar => "حسب الوكيل:",
        Lang::En => "By agent:",
    }
}

pub fn agent_session_count(lang: Lang, agent: &str, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("{agent} - {count} 个会话"),
        Lang::ZhTw => format!("{agent} - {count} 個對話"),
        Lang::Ja => format!("{agent} - {count} セッション"),
        Lang::Ko => format!("{agent} - {count}개 세션"),
        Lang::Es => format!("{agent} - {count} sesiones"),
        Lang::De => format!("{agent} - {count} Sitzungen"),
        Lang::Fr => format!("{agent} - {count} sessions"),
        Lang::Pt => format!("{agent} - {count} sessões"),
        Lang::Ar => format!("{agent} - {count} جلسات"),
        Lang::En => format!("{agent} - {count} sessions"),
    }
}

pub fn projects_label(lang: Lang, projects: &str) -> String {
    match lang {
        Lang::ZhCn => format!("涉及项目: {projects}"),
        Lang::ZhTw => format!("涉及專案: {projects}"),
        Lang::Ja => format!("関連プロジェクト: {projects}"),
        Lang::Ko => format!("관련 프로젝트: {projects}"),
        Lang::Es => format!("Proyectos: {projects}"),
        Lang::De => format!("Projekte: {projects}"),
        Lang::Fr => format!("Projets : {projects}"),
        Lang::Pt => format!("Projetos: {projects}"),
        Lang::Ar => format!("المشاريع: {projects}"),
        Lang::En => format!("Projects: {projects}"),
    }
}

pub fn key_activities_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "主要活动:",
        Lang::ZhTw => "主要活動:",
        Lang::Ja => "主な活動:",
        Lang::Ko => "주요 활동:",
        Lang::Es => "Actividades clave:",
        Lang::De => "Wichtige Aktivitäten:",
        Lang::Fr => "Activités principales :",
        Lang::Pt => "Atividades principais:",
        Lang::Ar => "الأنشطة الرئيسية:",
        Lang::En => "Key activities:",
    }
}

// ── Command responses ──

pub fn query_failed_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "查询失败",
        Lang::ZhTw => "查詢失敗",
        Lang::Ja => "クエリ失敗",
        Lang::Ko => "조회 실패",
        Lang::Es => "Error de consulta",
        Lang::De => "Abfrage fehlgeschlagen",
        Lang::Fr => "Échec de la requête",
        Lang::Pt => "Falha na consulta",
        Lang::Ar => "فشل الاستعلام",
        Lang::En => "Query Failed",
    }
}

pub fn no_conversations(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "暂无会话记录",
        Lang::ZhTw => "暫無對話記錄",
        Lang::Ja => "セッション履歴なし",
        Lang::Ko => "대화 기록 없음",
        Lang::Es => "Sin conversaciones",
        Lang::De => "Keine Sitzungen",
        Lang::Fr => "Aucune session",
        Lang::Pt => "Nenhuma sessão",
        Lang::Ar => "لا توجد جلسات",
        Lang::En => "No conversations found",
    }
}

pub fn recent_conversations_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "最近会话",
        Lang::ZhTw => "最近對話",
        Lang::Ja => "最近のセッション",
        Lang::Ko => "최근 대화",
        Lang::Es => "Conversaciones recientes",
        Lang::De => "Letzte Sitzungen",
        Lang::Fr => "Sessions récentes",
        Lang::Pt => "Sessões recentes",
        Lang::Ar => "الجلسات الأخيرة",
        Lang::En => "Recent Conversations",
    }
}

pub fn untitled(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "(无标题)",
        Lang::ZhTw => "(無標題)",
        Lang::Ja => "(無題)",
        Lang::Ko => "(제목 없음)",
        Lang::Es => "(Sin título)",
        Lang::De => "(Ohne Titel)",
        Lang::Fr => "(Sans titre)",
        Lang::Pt => "(Sem título)",
        Lang::Ar => "(بدون عنوان)",
        Lang::En => "(Untitled)",
    }
}

pub fn recent_n_conversations_title(lang: Lang, n: usize) -> String {
    match lang {
        Lang::ZhCn => format!("最近 {n} 条会话"),
        Lang::ZhTw => format!("最近 {n} 條對話"),
        Lang::Ja => format!("最新 {n} セッション"),
        Lang::Ko => format!("최근 {n}개 대화"),
        Lang::Es => format!("{n} conversaciones más recientes"),
        Lang::De => format!("Letzte {n} Sitzungen"),
        Lang::Fr => format!("{n} dernières sessions"),
        Lang::Pt => format!("{n} sessões mais recentes"),
        Lang::Ar => format!("أحدث {n} جلسات"),
        Lang::En => format!("{n} Most Recent Conversations"),
    }
}

pub fn search_no_results(lang: Lang, keyword: &str) -> String {
    match lang {
        Lang::ZhCn => format!("未找到包含 \"{keyword}\" 的会话"),
        Lang::ZhTw => format!("未找到包含 \"{keyword}\" 的對話"),
        Lang::Ja => format!("\"{keyword}\" を含むセッションが見つかりません"),
        Lang::Ko => format!("\"{keyword}\"을(를) 포함하는 대화를 찾을 수 없습니다"),
        Lang::Es => format!("No se encontraron conversaciones con \"{keyword}\""),
        Lang::De => format!("Keine Sitzungen mit \"{keyword}\" gefunden"),
        Lang::Fr => format!("Aucune session trouvée avec \"{keyword}\""),
        Lang::Pt => format!("Nenhuma sessão encontrada com \"{keyword}\""),
        Lang::Ar => format!("لم يتم العثور على جلسات تحتوي على \"{keyword}\""),
        Lang::En => format!("No conversations found matching \"{keyword}\""),
    }
}

pub fn search_results_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "搜索结果",
        Lang::ZhTw => "搜尋結果",
        Lang::Ja => "検索結果",
        Lang::Ko => "검색 결과",
        Lang::Es => "Resultados",
        Lang::De => "Suchergebnisse",
        Lang::Fr => "Résultats",
        Lang::Pt => "Resultados",
        Lang::Ar => "نتائج البحث",
        Lang::En => "Search Results",
    }
}

pub fn search_results_count_title(lang: Lang, keyword: &str, count: usize) -> String {
    match lang {
        Lang::ZhCn => format!("搜索 \"{keyword}\" - {count} 条结果"),
        Lang::ZhTw => format!("搜尋 \"{keyword}\" - {count} 條結果"),
        Lang::Ja => format!("\"{keyword}\" の検索 - {count} 件"),
        Lang::Ko => format!("\"{keyword}\" 검색 - {count}건"),
        Lang::Es => format!("Buscar \"{keyword}\" - {count} resultados"),
        Lang::De => format!("Suche \"{keyword}\" - {count} Ergebnisse"),
        Lang::Fr => format!("Recherche \"{keyword}\" - {count} résultats"),
        Lang::Pt => format!("Busca \"{keyword}\" - {count} resultados"),
        Lang::Ar => format!("بحث \"{keyword}\" - {count} نتائج"),
        Lang::En => format!("Search \"{keyword}\" - {count} results"),
    }
}

pub fn conversation_not_found(lang: Lang, id: i32) -> String {
    match lang {
        Lang::ZhCn => format!("会话 {id} 不存在"),
        Lang::ZhTw => format!("對話 {id} 不存在"),
        Lang::Ja => format!("セッション {id} が見つかりません"),
        Lang::Ko => format!("대화 {id}를 찾을 수 없습니다"),
        Lang::Es => format!("Conversación {id} no encontrada"),
        Lang::De => format!("Sitzung {id} nicht gefunden"),
        Lang::Fr => format!("Session {id} introuvable"),
        Lang::Pt => format!("Sessão {id} não encontrada"),
        Lang::Ar => format!("الجلسة {id} غير موجودة"),
        Lang::En => format!("Conversation {id} not found"),
    }
}

pub fn not_found_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "未找到",
        Lang::ZhTw => "未找到",
        Lang::Ja => "見つかりません",
        Lang::Ko => "찾을 수 없음",
        Lang::Es => "No encontrado",
        Lang::De => "Nicht gefunden",
        Lang::Fr => "Introuvable",
        Lang::Pt => "Não encontrado",
        Lang::Ar => "غير موجود",
        Lang::En => "Not Found",
    }
}

pub fn conversation_detail_title(lang: Lang, id: i32) -> String {
    match lang {
        Lang::ZhCn => format!("会话详情 #{id}"),
        Lang::ZhTw => format!("對話詳情 #{id}"),
        Lang::Ja => format!("セッション詳細 #{id}"),
        Lang::Ko => format!("대화 상세 #{id}"),
        Lang::Es => format!("Detalles #{id}"),
        Lang::De => format!("Sitzungsdetails #{id}"),
        Lang::Fr => format!("Détails #{id}"),
        Lang::Pt => format!("Detalhes #{id}"),
        Lang::Ar => format!("تفاصيل الجلسة #{id}"),
        Lang::En => format!("Conversation Details #{id}"),
    }
}

pub fn field_agent(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "代理",
        Lang::ZhTw => "代理",
        Lang::Ja => "エージェント",
        Lang::Ko => "에이전트",
        Lang::Es => "Agente",
        Lang::De => "Agent",
        Lang::Fr => "Agent",
        Lang::Pt => "Agente",
        Lang::Ar => "الوكيل",
        Lang::En => "Agent",
    }
}

pub fn field_status(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "状态",
        Lang::ZhTw => "狀態",
        Lang::Ja => "ステータス",
        Lang::Ko => "상태",
        Lang::Es => "Estado",
        Lang::De => "Status",
        Lang::Fr => "Statut",
        Lang::Pt => "Status",
        Lang::Ar => "الحالة",
        Lang::En => "Status",
    }
}

pub fn field_message_count(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "消息数",
        Lang::ZhTw => "訊息數",
        Lang::Ja => "メッセージ数",
        Lang::Ko => "메시지 수",
        Lang::Es => "Mensajes",
        Lang::De => "Nachrichten",
        Lang::Fr => "Messages",
        Lang::Pt => "Mensagens",
        Lang::Ar => "عدد الرسائل",
        Lang::En => "Messages",
    }
}

pub fn field_created_at(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "创建时间",
        Lang::ZhTw => "建立時間",
        Lang::Ja => "作成日時",
        Lang::Ko => "생성 시간",
        Lang::Es => "Creado",
        Lang::De => "Erstellt",
        Lang::Fr => "Créé",
        Lang::Pt => "Criado",
        Lang::Ar => "تاريخ الإنشاء",
        Lang::En => "Created",
    }
}

pub fn no_activity_today(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "今日暂无编码活动",
        Lang::ZhTw => "今日暫無編碼活動",
        Lang::Ja => "本日のコーディング活動はありません",
        Lang::Ko => "오늘 코딩 활동이 없습니다",
        Lang::Es => "Sin actividad de codificación hoy",
        Lang::De => "Heute keine Coding-Aktivität",
        Lang::Fr => "Aucune activité de codage aujourd'hui",
        Lang::Pt => "Nenhuma atividade de codificação hoje",
        Lang::Ar => "لا يوجد نشاط برمجة اليوم",
        Lang::En => "No coding activity today",
    }
}

pub fn today_activity_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "今日活动",
        Lang::ZhTw => "今日活動",
        Lang::Ja => "本日の活動",
        Lang::Ko => "오늘의 활동",
        Lang::Es => "Actividad de hoy",
        Lang::De => "Heutige Aktivität",
        Lang::Fr => "Activité du jour",
        Lang::Pt => "Atividade de hoje",
        Lang::Ar => "نشاط اليوم",
        Lang::En => "Today's Activity",
    }
}

pub fn today_activity_date_title(lang: Lang, date: &str) -> String {
    match lang {
        Lang::ZhCn => format!("今日活动 ({date})"),
        Lang::ZhTw => format!("今日活動 ({date})"),
        Lang::Ja => format!("本日の活動 ({date})"),
        Lang::Ko => format!("오늘의 활동 ({date})"),
        Lang::Es => format!("Actividad de hoy ({date})"),
        Lang::De => format!("Heutige Aktivität ({date})"),
        Lang::Fr => format!("Activité du jour ({date})"),
        Lang::Pt => format!("Atividade de hoje ({date})"),
        Lang::Ar => format!("نشاط اليوم ({date})"),
        Lang::En => format!("Today's Activity ({date})"),
    }
}

pub fn agent_count(lang: Lang, agent: &str, count: u32) -> String {
    match lang {
        Lang::ZhCn => format!("{agent} - {count} 个"),
        Lang::ZhTw => format!("{agent} - {count} 個"),
        Lang::Ja => format!("{agent} - {count} 件"),
        Lang::Ko => format!("{agent} - {count}개"),
        Lang::Es | Lang::De | Lang::Fr | Lang::Pt | Lang::Ar | Lang::En => {
            format!("{agent} - {count}")
        }
    }
}

pub fn recent_activity_label(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "最近活动:",
        Lang::ZhTw => "最近活動:",
        Lang::Ja => "最近の活動:",
        Lang::Ko => "최근 활동:",
        Lang::Es => "Actividad reciente:",
        Lang::De => "Letzte Aktivität:",
        Lang::Fr => "Activité récente :",
        Lang::Pt => "Atividade recente:",
        Lang::Ar => "النشاط الأخير:",
        Lang::En => "Recent activity:",
    }
}

pub fn no_active_channels(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "暂无活跃渠道",
        Lang::ZhTw => "暫無活躍頻道",
        Lang::Ja => "アクティブなチャンネルなし",
        Lang::Ko => "활성 채널 없음",
        Lang::Es => "Sin canales activos",
        Lang::De => "Keine aktiven Kanäle",
        Lang::Fr => "Aucun canal actif",
        Lang::Pt => "Nenhum canal ativo",
        Lang::Ar => "لا توجد قنوات نشطة",
        Lang::En => "No active channels",
    }
}

pub fn channel_status_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "渠道状态",
        Lang::ZhTw => "頻道狀態",
        Lang::Ja => "チャンネル状況",
        Lang::Ko => "채널 상태",
        Lang::Es => "Estado de canales",
        Lang::De => "Kanalstatus",
        Lang::Fr => "Statut des canaux",
        Lang::Pt => "Status dos canais",
        Lang::Ar => "حالة القنوات",
        Lang::En => "Channel Status",
    }
}

pub fn help_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "Codeg Bot 帮助",
        Lang::ZhTw => "Codeg Bot 幫助",
        Lang::Ja => "Codeg Bot ヘルプ",
        Lang::Ko => "Codeg Bot 도움말",
        Lang::Es => "Ayuda de Codeg Bot",
        Lang::De => "Codeg Bot Hilfe",
        Lang::Fr => "Aide Codeg Bot",
        Lang::Pt => "Ajuda do Codeg Bot",
        Lang::Ar => "مساعدة Codeg Bot",
        Lang::En => "Codeg Bot Help",
    }
}

pub fn help_body(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!(
            "📂 {prefix}folder - 选择工作目录\n\
             🤖 {prefix}agent - 选择 Agent\n\
             🚀 {prefix}task <描述> - 创建会话并执行任务\n\
             📋 {prefix}sessions - 当前目录的活跃会话\n\
             ▶️ {prefix}resume <ID> - 恢复已有会话\n\
             ⏹️ {prefix}cancel - 取消当前任务\n\
             ✅ {prefix}approve [always] - 批准权限请求\n\
             ❌ {prefix}deny - 拒绝权限请求\n\
             \n\
             {prefix}recent - 最近 5 条会话\n\
             {prefix}search <关键词> - 搜索会话\n\
             {prefix}detail <ID> - 会话详情\n\
             {prefix}today - 今日活动汇总\n\
             {prefix}status - 渠道连接状态\n\
             {prefix}help - 显示帮助\n\
             \n\
             💡 有活跃会话时，直接发文本即可继续对话"
        ),
        Lang::ZhTw => format!(
            "{prefix}recent - 最近 5 條對話\n\
             {prefix}search <關鍵字> - 搜尋對話\n\
             {prefix}detail <ID> - 對話詳情\n\
             {prefix}today - 今日活動匯總\n\
             {prefix}status - 頻道連線狀態\n\
             {prefix}help - 顯示幫助"
        ),
        Lang::Ja => format!(
            "{prefix}recent - 最新5件のセッション\n\
             {prefix}search <キーワード> - セッション検索\n\
             {prefix}detail <ID> - セッション詳細\n\
             {prefix}today - 本日の活動まとめ\n\
             {prefix}status - チャンネル接続状況\n\
             {prefix}help - ヘルプを表示"
        ),
        Lang::Ko => format!(
            "{prefix}recent - 최근 5개 대화\n\
             {prefix}search <키워드> - 대화 검색\n\
             {prefix}detail <ID> - 대화 상세\n\
             {prefix}today - 오늘의 활동 요약\n\
             {prefix}status - 채널 연결 상태\n\
             {prefix}help - 도움말 표시"
        ),
        Lang::Es => format!(
            "{prefix}recent - 5 conversaciones más recientes\n\
             {prefix}search <palabra> - Buscar conversaciones\n\
             {prefix}detail <ID> - Detalles de conversación\n\
             {prefix}today - Resumen de hoy\n\
             {prefix}status - Estado de canales\n\
             {prefix}help - Mostrar ayuda"
        ),
        Lang::De => format!(
            "{prefix}recent - 5 neueste Sitzungen\n\
             {prefix}search <Stichwort> - Sitzungen suchen\n\
             {prefix}detail <ID> - Sitzungsdetails\n\
             {prefix}today - Heutige Zusammenfassung\n\
             {prefix}status - Kanalstatus\n\
             {prefix}help - Hilfe anzeigen"
        ),
        Lang::Fr => format!(
            "{prefix}recent - 5 dernières sessions\n\
             {prefix}search <mot-clé> - Rechercher des sessions\n\
             {prefix}detail <ID> - Détails de la session\n\
             {prefix}today - Résumé du jour\n\
             {prefix}status - Statut des canaux\n\
             {prefix}help - Afficher l'aide"
        ),
        Lang::Pt => format!(
            "{prefix}recent - 5 sessões mais recentes\n\
             {prefix}search <palavra> - Buscar sessões\n\
             {prefix}detail <ID> - Detalhes da sessão\n\
             {prefix}today - Resumo de hoje\n\
             {prefix}status - Status dos canais\n\
             {prefix}help - Mostrar ajuda"
        ),
        Lang::Ar => format!(
            "{prefix}recent - أحدث 5 جلسات\n\
             {prefix}search <كلمة> - البحث في الجلسات\n\
             {prefix}detail <ID> - تفاصيل الجلسة\n\
             {prefix}today - ملخص اليوم\n\
             {prefix}status - حالة القنوات\n\
             {prefix}help - عرض المساعدة"
        ),
        Lang::En => format!(
            "📂 {prefix}folder - Select working folder\n\
             🤖 {prefix}agent - Select agent\n\
             🚀 {prefix}task <desc> - Create session & run task\n\
             📋 {prefix}sessions - Active sessions in folder\n\
             ▶️ {prefix}resume <ID> - Resume a session\n\
             ⏹️ {prefix}cancel - Cancel current task\n\
             ✅ {prefix}approve [always] - Approve permission\n\
             ❌ {prefix}deny - Deny permission\n\
             \n\
             {prefix}recent - 5 most recent conversations\n\
             {prefix}search <keyword> - Search conversations\n\
             {prefix}detail <ID> - Conversation details\n\
             {prefix}today - Today's activity summary\n\
             {prefix}status - Channel connection status\n\
             {prefix}help - Show help\n\
             \n\
             💡 When a session is active, just type text to continue the conversation"
        ),
    }
}

// ── Command dispatcher messages ──

pub fn invalid_args_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "参数错误",
        Lang::ZhTw => "參數錯誤",
        Lang::Ja => "引数エラー",
        Lang::Ko => "인수 오류",
        Lang::Es => "Argumentos inválidos",
        Lang::De => "Ungültige Argumente",
        Lang::Fr => "Arguments invalides",
        Lang::Pt => "Argumentos inválidos",
        Lang::Ar => "وسيطات غير صالحة",
        Lang::En => "Invalid Arguments",
    }
}

pub fn search_usage(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("用法: {prefix}search <关键词>"),
        Lang::ZhTw => format!("用法: {prefix}search <關鍵字>"),
        Lang::Ja => format!("使い方: {prefix}search <キーワード>"),
        Lang::Ko => format!("사용법: {prefix}search <키워드>"),
        Lang::Es => format!("Uso: {prefix}search <palabra>"),
        Lang::De => format!("Verwendung: {prefix}search <Stichwort>"),
        Lang::Fr => format!("Utilisation : {prefix}search <mot-clé>"),
        Lang::Pt => format!("Uso: {prefix}search <palavra>"),
        Lang::Ar => format!("الاستخدام: {prefix}search <كلمة>"),
        Lang::En => format!("Usage: {prefix}search <keyword>"),
    }
}

pub fn detail_usage(lang: Lang, prefix: &str) -> String {
    match lang {
        Lang::ZhCn => format!("用法: {prefix}detail <会话ID>"),
        Lang::ZhTw => format!("用法: {prefix}detail <對話ID>"),
        Lang::Ja => format!("使い方: {prefix}detail <セッションID>"),
        Lang::Ko => format!("사용법: {prefix}detail <대화ID>"),
        Lang::Es => format!("Uso: {prefix}detail <ID>"),
        Lang::De => format!("Verwendung: {prefix}detail <ID>"),
        Lang::Fr => format!("Utilisation : {prefix}detail <ID>"),
        Lang::Pt => format!("Uso: {prefix}detail <ID>"),
        Lang::Ar => format!("الاستخدام: {prefix}detail <ID>"),
        Lang::En => format!("Usage: {prefix}detail <ID>"),
    }
}

pub fn unknown_command(lang: Lang, prefix: &str, command: &str) -> String {
    match lang {
        Lang::ZhCn => format!(
            "未知命令: {prefix}{command}\n输入 {prefix}help 查看可用命令"
        ),
        Lang::ZhTw => format!(
            "未知命令: {prefix}{command}\n輸入 {prefix}help 查看可用命令"
        ),
        Lang::Ja => format!(
            "不明なコマンド: {prefix}{command}\n{prefix}help でヘルプを表示"
        ),
        Lang::Ko => format!(
            "알 수 없는 명령: {prefix}{command}\n{prefix}help 로 도움말 보기"
        ),
        Lang::Es => format!(
            "Comando desconocido: {prefix}{command}\nEscriba {prefix}help para ver los comandos"
        ),
        Lang::De => format!(
            "Unbekannter Befehl: {prefix}{command}\n{prefix}help für Hilfe eingeben"
        ),
        Lang::Fr => format!(
            "Commande inconnue : {prefix}{command}\nTapez {prefix}help pour l'aide"
        ),
        Lang::Pt => format!(
            "Comando desconhecido: {prefix}{command}\nDigite {prefix}help para ajuda"
        ),
        Lang::Ar => format!(
            "أمر غير معروف: {prefix}{command}\nاكتب {prefix}help لعرض المساعدة"
        ),
        Lang::En => format!(
            "Unknown command: {prefix}{command}\nType {prefix}help for available commands"
        ),
    }
}

pub fn unknown_command_title(lang: Lang) -> &'static str {
    match lang {
        Lang::ZhCn => "未知命令",
        Lang::ZhTw => "未知命令",
        Lang::Ja => "不明なコマンド",
        Lang::Ko => "알 수 없는 명령",
        Lang::Es => "Comando desconocido",
        Lang::De => "Unbekannter Befehl",
        Lang::Fr => "Commande inconnue",
        Lang::Pt => "Comando desconhecido",
        Lang::Ar => "أمر غير معروف",
        Lang::En => "Unknown Command",
    }
}
