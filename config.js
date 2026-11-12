// ============================================================
//  config.js ― 教員が編集するファイルです（他のファイルは触りません）
// ============================================================
//
//  【構造】 建物 ＞ 時期(期) ＞ タグ / クイズ / 動画
//
//  ・建物を増やす … BUILDINGS の中に kit2 のブロックをコピーして、IDと中身を書き換える
//  ・時期を増やす … periods の中に { ... } のブロックをコピーして、id を変える
//  ・タグを増やす … tags の中に { ... } のブロックをコピーして、座標などを書き換える
//
//  【書き方の注意】
//  ・ブロックとブロックの間には、カンマ「,」が必要です
//  ・文字は半角の ""（ダブルクォート）で囲みます
//  ・クイズの answer は "A" "B" "C" "D" のどれか（options の順番に対応）
//  ・記述式の問題は type: "text" と answers: ["正解1", "正解2"] を書く（options と answer は不要）
//  ・座標(x, y, z)とSweep IDは、ページを ?edit=1 付きで開くと画面に表示されます
//    例: http://localhost:8080/?building=kit2&edit=1
//  ・座標とSweep IDは「モデルごと」に違います。時期ごとに調べ直してください
//
// ============================================================

export const SETTINGS = {
      useSheet: true,
  // クイズの回答を送る先（Google Apps Script の URL）
  gasUrl: "https://script.google.com/macros/s/AKfycbwwg0RPJ7JVDc2n0Yxz1UbNGBeiB7cuI3oO9WxuL3N89UK_E-_m_rpkr9PYnB9Xpyes/exec"
};

export const BUILDINGS = {

  // ---------- 建物ID（URLの ?building=kit2 に対応） ----------
  kit2: {
    name: "金沢工業大学2号館",

    // 建物共通の動画ID（時期ごとに videoId を書いた場合は、そちらが優先）
    // 動画を使わないなら、この行ごと消して構いません
    // videoId: "dOuyHlCzE4w",

    periods: [

      // ---------- 第1期 ----------
      {
        id: "p1",                 // 英数字。他の期と重ならないように
        name: "第1期",            // 画面のボタンに出る名前（例: 基礎工事）
        modelUrl: "https://my.matterport.com/show?m=S4BUETgtwbJ&play=1&applicationKey=ymffii7dt0x20s12nuw4z72nd",
        videoId: "dOuyHlCzE4w",   // この期の解説動画（YouTubeの動画ID）。なければ行ごと削除

        // ----- メイン画面のクイズ（◇メニューの「クイズ」） -----
        quiz: [
          {
            question: "金沢工業大学２号館の構造は？",
            options: ["木造", "鉄筋コンクリート造", "鉄骨造"],
            answer: "B",
            sweepId: "ifhi11ih500zxbpyyxbn78u2b"   // 解説の場所。なければ "" にする
          },
          {
            question: "金沢工業大学２号館の竣工時期は？",
            options: ["1959", "1969", "1979"],
            answer: "B",
            sweepId: "ha59ay42rqzmxznw7cfwq3nnc"
          },
          {
            question: "金沢市にある有名な美術館は？",
            options: ["21世紀美術館", "国立西洋美術館", "森美術館"],
            answer: "A",
            sweepId: ""   // ← 3問目のSweep IDはまだ未設定
          }
        ],

        // ----- タグ（4〜5個まで増やせます） -----
        tags: [
          {
            label: "中二階",
            description: "金沢工業大学2号館の中二階です。",
            x: 1.9177, y: -1.2143, z: 5.0489,

            // タグを開いたパネルの「画像」タブ。なければ images: [] にする
            images: [
              "https://www.kanazawa-it.ac.jp/campus_guide/2024/campus_map/img/map_1.png"
            ],

            // タグを開いたパネルの「クイズ」タブ。なければ quiz: [] にする
            quiz: [
              {
                question: "第1問：この場所はどこの大学にあるでしょう？",
                options: ["金沢工業大学", "金沢大学", "富山大学"],
                answer: "A"
              },
              {
                question: "第2問：この場所は建物のどの部分でしょう？",
                options: ["屋上", "中二階", "地下"],
                answer: "B"
              },
              {
                question: "第3問：Matterportを使うと、どんなことができるか自由に書いてください。",
                type: "text",                          // ← 記述問題の印
                answers: ["3D空間を見て回る", "見て回る", "バーチャルツアー"]   // ← 正解として認める答え（どれか1つ合えば正解）
              }
            ]
          }

          // ↓ タグを足すときは、上の } の後ろに「,」を付けて、ここにコピーして書き換える
          // ,{
          //   label: "タグ名", description: "説明文",
          //   x: 0, y: 0, z: 0,
          //   images: [], quiz: []
          // }
        ]
      }

      // ↓ 時期を足すときは、上の } の後ろに「,」を付けて、ここに期のブロックをコピーする
      // ,{
      //   id: "p2", name: "第2期", modelUrl: "...", quiz: [], tags: []
      // }
    ]
  }

  // ↓ 建物を足すときは、上の } の後ろに「,」を付けて、ここに建物のブロックをコピーする
  // ,kit3: { name: "○○棟", periods: [ ... ] }
};